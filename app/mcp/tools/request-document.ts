import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { v4 as uuidv4 } from "uuid";
import { sql } from "@/lib/db";
import {
  matchIndexedDocuments,
  isDuplicatePendingRequest,
  isMissingTable,
  MISSING_TABLE_MESSAGE,
  MAX_PENDING_REQUESTS,
  MAX_REASON_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
  normalizeTitle,
} from "@/lib/documentRequests";

/**
 * `request_document` records a gap in the corpus. It deliberately does not
 * fetch anything: `/mcp` is public (see middleware.ts), so this is an
 * unauthenticated write, and a tool that downloaded a model-supplied URL
 * server-side would be an open SSRF proxy. The URL is stored as a suggestion
 * and is only ever fetched after a signed-in human approves it on the upload
 * page.
 */
export function registerRequestDocumentTool(server: McpServer): void {
  server.registerTool(
    "request_document",
    {
      title: "request_document",
      description:
        "Request that a document be added to the knowledge base. Use this " +
        "only after search_docs and search_graph have both failed to find a " +
        "document you need — it is for gaps in the corpus, not for retrieval. " +
        "BEFORE calling this, read the `kb://documents` resource and confirm " +
        "the document is not already indexed under a different name: search " +
        "can miss a document that is present, and a file name rarely matches " +
        "the official title. Set `checkedIndexedDocuments` to true only once " +
        "you have actually read that resource and checked. " +
        "Nothing is added automatically: the request goes to a review queue " +
        "for a human to approve or reject, so tell the user you have logged " +
        "the request rather than implying the document is now available. " +
        "Give the document's full official title, not a paraphrase, and say " +
        "in `reason` what question it would have answered. " +
        "Include `sourceUrl` whenever you can find one — a request carrying a " +
        "direct link to the PDF can be approved and ingested in one action, " +
        "while one without it stalls until a human goes and finds the file. " +
        "It is worth a search to locate the publisher's download link before " +
        "calling this.",
      inputSchema: z.object({
        title: z
          .string()
          .min(3)
          .max(MAX_TITLE_LENGTH)
          .describe("Full official title of the document, as it would be published"),
        reason: z
          .string()
          .max(MAX_REASON_LENGTH)
          .describe("What the document is needed for — the question it would answer")
          .optional(),
        sourceUrl: z
          .string()
          .max(MAX_URL_LENGTH)
          .describe(
            "Direct https:// link to the PDF itself, not a landing or search page. " +
              "Strongly preferred: it is what lets a reviewer approve and ingest in " +
              "one action. Omit only if you genuinely cannot find one"
          )
          .optional(),
        requestedBy: z
          .string()
          .max(200)
          .describe("Who or what is asking, if the client knows")
          .optional(),
        checkedIndexedDocuments: z
          .boolean()
          .describe(
            "True only if you have read the kb://documents resource and confirmed " +
              "this document is not already indexed under a different name"
          ),
      }),
    },
    async ({ title, reason, sourceUrl, requestedBy, checkedIndexedDocuments }) => {
      try {
        const trimmed = title.trim();
        const key = normalizeTitle(trimmed);

        // The client is asked to check kb://documents first. Refusing here
        // rather than trusting the flag to be set thoughtfully is the point:
        // it makes the resource read part of the protocol instead of advice
        // buried in a description the model may skim.
        if (!checkedIndexedDocuments) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No request was created. Read the \`kb://documents\` resource first ` +
                  `and confirm "${trimmed}" is not already indexed under a different ` +
                  `name — file names rarely match official titles, so search missing ` +
                  `it is not proof it is absent. Then call again with ` +
                  `checkedIndexedDocuments: true.`,
              },
            ],
            structuredContent: { created: false, reason: "index-not-checked", title: trimmed },
          };
        }

        // The authoritative check, regardless of what the client attested.
        // Compared on tokens rather than with LIKE: a request carries a prose
        // title ("B2B Procedure: Technical Delivery Specification") while the
        // corpus stores a file name ("B2B-Procedure-Technical-Delivery-Spec-
        // v3.2.pdf"), and no substring of one appears in the other.
        const indexed = await sql`SELECT name FROM uploads`;
        const matches = matchIndexedDocuments(
          trimmed,
          indexed.map((row) => row.name as string)
        ).slice(0, 3);

        if (matches.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No request was created — the knowledge base already holds ` +
                  `${matches.length === 1 ? "a document" : "documents"} that may be ` +
                  `"${trimmed}":\n` +
                  matches
                    .map((m) => `- ${m.name} (${Math.round(m.coverage * 100)}% title overlap)`)
                    .join("\n") +
                  `\n\nSearch again using that exact name. If none of these is the ` +
                  `document you mean, call again with a title that distinguishes it.`,
              },
            ],
            structuredContent: {
              created: false,
              reason: "already-indexed",
              title: trimmed,
              matches,
            },
          };
        }

        const pending = await sql`
          SELECT id, title FROM document_requests WHERE status = 'pending'
        `;

        const duplicate = pending.find((row) => normalizeTitle(row.title) === key);
        if (duplicate) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `"${trimmed}" is already in the review queue awaiting approval. ` +
                  `No second request was created.`,
              },
            ],
            structuredContent: {
              created: false,
              reason: "already-requested",
              requestId: duplicate.id,
              title: trimmed,
            },
          };
        }

        if (pending.length >= MAX_PENDING_REQUESTS) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `The review queue is full (${MAX_PENDING_REQUESTS} pending requests). ` +
                  `No request was created; ask the operator to work through the queue.`,
              },
            ],
            structuredContent: { created: false, reason: "queue-full", title: trimmed },
          };
        }

        const id = uuidv4();
        await sql`
          INSERT INTO document_requests (id, title, reason, source_url, requested_by)
          VALUES (
            ${id},
            ${trimmed},
            ${reason?.trim() || null},
            ${sourceUrl?.trim() || null},
            ${requestedBy?.trim() || null}
          )
        `;

        const url = sourceUrl?.trim() || null;

        // Reflect back what the request can actually do, rather than a flat
        // acknowledgement: with a link a reviewer approves and ingestion
        // starts; without one the request sits until someone hunts the file
        // down, and the model is the party best placed to have found it.
        const followUp = url
          ? `A reviewer can approve it and the PDF will be fetched from ${url} automatically.`
          : `No source URL was supplied, so it cannot be approved until someone locates ` +
            `the PDF by hand. If you can find a direct link to the file, say so — it can ` +
            `be added when the request is reviewed.`;

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Logged a request for "${trimmed}". It is queued for human review ` +
                `and is not searchable yet — tell the user the request was recorded, ` +
                `not that the document is available. ${followUp}`,
            },
          ],
          structuredContent: {
            created: true,
            requestId: id,
            title: trimmed,
            status: "pending",
            sourceUrl: url,
            // Explicit so a client can surface "needs a link" without parsing prose.
            awaitingSourceUrl: url === null,
          },
        };
      } catch (error) {
        console.error("[request_document] failed:", error);

        // One known, actionable condition, lifted out of the generic branch.
        // Left there it reaches the model as `relation "document_requests"
        // does not exist` — which it cannot act on, may relay as "the feature
        // is broken", and which puts a raw driver error on a public
        // unauthenticated endpoint for no benefit.
        if (isMissingTable(error)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  `The document request queue is not set up on this server, so ` +
                  `"${title.trim()}" was NOT recorded. Tell the user the request could ` +
                  `not be logged — do not imply it is queued or that the document ` +
                  `will be added. An operator needs to run db/document_requests.sql ` +
                  `against the database first.`,
              },
            ],
            structuredContent: {
              created: false,
              reason: "queue-not-provisioned",
              title: title.trim(),
            },
          };
        }

        // Lost a race against another client asking for the same document.
        // The pre-insert check above cannot see a row that was not committed
        // when it ran, so the unique index is what actually settles it — and
        // its constraint name is no more use to a model than a relation error.
        if (isDuplicatePendingRequest(error)) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `"${title.trim()}" is already in the review queue awaiting approval — ` +
                  `another request for it arrived first. No second request was created.`,
              },
            ],
            structuredContent: {
              created: false,
              reason: "already-requested",
              title: title.trim(),
            },
          };
        }

        // Everything else keeps the real message, per .claude/rules/mcp-tools.md.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Could not record the document request: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
