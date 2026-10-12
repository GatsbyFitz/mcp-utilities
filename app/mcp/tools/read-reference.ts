import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { DocumentFetchError, fetchTextFromUrl } from "@/lib/fetchDocument";
import {
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_CHARS,
  REFERENCES,
  emptyShellMessage,
  htmlToText,
  looksLikeEmptyShell,
  referenceByName,
  renderReferenceList,
} from "@/lib/references";

// ---------------------------------------------------------------------------
// read_reference — live pages, not indexed ones
// ---------------------------------------------------------------------------
// The one tool here that does not read a store. Everything else answers from
// Upstash, Neo4j or Postgres, which is right for regulatory documents: long,
// stable, and best answered by the paragraphs that matter.
//
// API documentation is the opposite on the axis that counts. It versions, and
// stale is its failure mode — a moved endpoint reads exactly like a current
// one, so an indexed copy is a confident lie with a citation attached. This
// fetches instead. See lib/references.ts.
//
// **The parameter is a name, never a URL.** A URL argument validated against
// an allowlist is a filter, and filters are bypassed — by a redirect, a
// lookalike host, an open redirector on an allowed origin. A key into a
// server-side map cannot be. That is also what makes this safe enough to be
// worth having: nothing here fetches a model-chosen address.

export function registerReadReferenceTool(server: McpServer): void {
  server.registerTool(
    "read_reference",
    {
      title: "read_reference",
      description:
        "Read a reference page live, by name. These are sources that are kept " +
        "current rather than indexed, because being out of date is their worst " +
        "failure — API documentation above all, where a moved endpoint looks " +
        "exactly like a working one. Returns the page's text as it is right " +
        "now. Available references:\n" +
        `${renderReferenceList()}\n` +
        "Use this when the question is about calling an API or about a live " +
        "specification. For what the market rules require, and for anything " +
        "where a citation matters, use search_docs — these pages are not in " +
        "the index and carry no page citations.",
      inputSchema: z.object({
        name: z
          .string()
          .max(100)
          .describe("The reference's name, exactly as listed in this tool's description."),
      }),
    },
    async ({ name }) => {
      const reference = referenceByName(name);
      if (!reference) {
        // A miss returns the catalogue rather than an apology: the next call
        // should be able to succeed without another round trip.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `No reference named "${name}". Available:\n${renderReferenceList()}`,
            },
          ],
        };
      }

      try {
        const { body, contentType, truncated } = await fetchTextFromUrl(
          reference.url,
          MAX_REFERENCE_BYTES
        );

        // A spec or a plain-text page is already what we want; only markup
        // needs stripping.
        const isMarkup = contentType.includes("html") || contentType.includes("xml");
        const text = isMarkup ? htmlToText(body) : body.trim();

        // The failure worth naming. A JavaScript-rendered docs site answers
        // 200 with a shell, extraction yields nothing, and silence reads as
        // "the documentation does not cover that" — which is indistinguishable
        // from a true answer and worse than an error.
        if (isMarkup && looksLikeEmptyShell(body, text)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: emptyShellMessage(reference) }],
            structuredContent: {
              name: reference.name,
              url: reference.url,
              emptyShell: true,
              bytes: body.length,
              textLength: text.length,
            },
          };
        }

        const clipped = text.slice(0, MAX_REFERENCE_CHARS);
        const shortened = clipped.length < text.length || truncated;

        return {
          content: [
            {
              type: "text" as const,
              text:
                `${reference.label}\nFetched live from ${reference.url}\n` +
                // Said every time, not only when it bites: this content is not
                // in the index, so it cannot be cited like a document and will
                // not appear in a search_docs result.
                `(Live page, not an indexed document — no page citations.)\n\n` +
                `${clipped}` +
                (shortened ? `\n\n[Truncated. Open ${reference.url} for the rest.]` : ""),
            },
          ],
          structuredContent: {
            name: reference.name,
            url: reference.url,
            label: reference.label,
            text: clipped,
            truncated: shortened,
            emptyShell: false,
          },
        };
      } catch (error) {
        // A refusal from the fetcher names what was wrong with the source and
        // is safe to show — the URL is this server's own. Anything else is
        // reported generically, with the URL so a person can go and look.
        const detail =
          error instanceof DocumentFetchError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Unknown error";
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Could not read ${reference.label}: ${detail}. ` +
                `This says nothing about what the documentation contains — ` +
                `the page was not read. Open ${reference.url} directly.`,
            },
          ],
        };
      }
    }
  );
}

/** Exported for the resource that lists what is available. */
export { REFERENCES };
