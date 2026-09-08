import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { v4 as uuidv4 } from "uuid";
import { sql } from "@/lib/db";
import {
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
        "Nothing is added automatically: the request goes to a review queue " +
        "for a human to approve or reject, so tell the user you have logged " +
        "the request rather than implying the document is now available. " +
        "Give the document's full official title, not a paraphrase, and say " +
        "in `reason` what question it would have answered.",
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
          .describe("Where the document can be obtained, if known. Advisory only")
          .optional(),
        requestedBy: z
          .string()
          .max(200)
          .describe("Who or what is asking, if the client knows")
          .optional(),
      }),
    },
    async ({ title, reason, sourceUrl, requestedBy }) => {
      try {
        const trimmed = title.trim();
        const key = normalizeTitle(trimmed);

        // Already ingested? Say so instead of queueing work that is not needed
        // — the model may simply have phrased its search badly.
        const existing = await sql`
          SELECT name FROM uploads WHERE LOWER(TRIM(name)) LIKE ${`%${key}%`} LIMIT 1
        `;
        if (existing.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `"${existing[0].name}" is already in the knowledge base and looks ` +
                  `like a match for "${trimmed}". No request was created — try ` +
                  `search_docs again with wording closer to that title.`,
              },
            ],
            structuredContent: { created: false, reason: "already-indexed", title: trimmed },
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

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Logged a request for "${trimmed}". It is queued for human review ` +
                `and is not searchable yet — tell the user the request was recorded, ` +
                `not that the document is available.`,
            },
          ],
          structuredContent: { created: true, requestId: id, title: trimmed, status: "pending" },
        };
      } catch (error) {
        console.error("[request_document] failed:", error);
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
