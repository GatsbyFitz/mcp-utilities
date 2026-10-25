import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  MAX_REFERENCE_KEY_TERMS,
  MAX_REFERENCE_SUMMARY,
  MISSING_REFERENCES_MESSAGE,
  isMissingReferenceTable,
  nameFromUrl,
  normalizeReferenceName,
  referenceNameProblem,
  referenceProblem,
} from "@/lib/references";
import { start } from "workflow/api";
import { indexReferencePage } from "@/app/api/indexReference/workflow";

// ---------------------------------------------------------------------------
// add_reference — the other half of find_reference
// ---------------------------------------------------------------------------
// find_reference can only route to pages something has registered, and the
// thing best placed to register them is whatever just read one. This server
// cannot: the pages worth referencing render client-side and are not
// resolvable from its network. The caller has already opened the page, so it
// can describe it.
//
// The descriptor is written, not scraped, and that is the whole contract: it
// says what the page *covers*, so it survives the page changing. A summary
// that paraphrases today's contents is the thing this design exists to avoid —
// it goes stale silently and routes a question to a page that no longer
// answers it.
//
// Queued, not indexed. The write runs as a durable workflow so each step
// retries on its own and the upload page can show it moving, which means this
// returns before the reference is searchable. The tool says so rather than
// implying otherwise — a model that adds a page and then immediately fails to
// find it would reasonably conclude the add had failed.

export function registerAddReferenceTool(server: McpServer): void {
  server.registerTool(
    "add_reference",
    {
      title: "add_reference",
      description:
        "Register a live web page so find_reference can route future questions " +
        "to it. Use this after reading a page worth coming back to — API " +
        "documentation, a specification, a developer portal — especially when " +
        "find_reference returned nothing for a question the page answers. " +
        "The page is NOT copied: only your description of it is stored, and " +
        "the page itself is read live each time. " +
        "Write `summary` as what the page COVERS and which questions it " +
        "answers, not as a précis of its current contents — endpoints, limits " +
        "and parameters change, and a summary describing them goes stale and " +
        "silently misroutes. \"Documents the NEM Dispatch Bidding API: " +
        "submitting energy, FCAS and MNSP bids\" is right; \"lists POST /bids " +
        "with fields x, y, z\" is wrong. " +
        "Put literal terms a question would use — API names, system names, " +
        "message types, acronyms — in `keyTerms`; they are matched exactly and " +
        "are how an opaque token finds the right page. " +
        "One page, one entry: re-adding the same URL updates it rather than " +
        "creating a second. Add a page only if you have actually opened it.",
      inputSchema: z.object({
        url: z.string().max(2000).describe("The page's https:// URL."),
        title: z.string().max(300).describe("What the page is called."),
        summary: z
          .string()
          .max(MAX_REFERENCE_SUMMARY)
          .describe("What this page covers and which questions it answers."),
        keyTerms: z
          .array(z.string().max(100))
          .optional()
          .describe("Literal terms a question would use: API names, acronyms, message types."),
      }),
    },
    async ({ url, title, summary, keyTerms }) => {
      const problem = referenceProblem({ url, title, summary });
      if (problem) {
        return { isError: true, content: [{ type: "text" as const, text: problem }] };
      }

      const trimmedUrl = url.trim();
      const trimmedTitle = title.trim();
      const name = normalizeReferenceName(trimmedTitle) || nameFromUrl(trimmedUrl);

      const nameProblem = referenceNameProblem(name);
      if (nameProblem) {
        return { isError: true, content: [{ type: "text" as const, text: nameProblem }] };
      }

      const terms = (keyTerms ?? [])
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, MAX_REFERENCE_KEY_TERMS);

      try {
        const run = await start(indexReferencePage, [
          {
            name,
            url: trimmedUrl,
            title: trimmedTitle,
            summary: summary.trim().slice(0, MAX_REFERENCE_SUMMARY),
            keyTerms: terms,
          },
        ]);

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Queued "${trimmedTitle}" as reference "${name}". Indexing runs ` +
                `in the background and takes a few seconds, so find_reference ` +
                `may not return it immediately. The page itself is not stored — ` +
                `${trimmedUrl} is read live whenever it is needed.`,
            },
          ],
          structuredContent: {
            name,
            url: trimmedUrl,
            title: trimmedTitle,
            keyTerms: terms,
            runId: run.runId,
            queued: true,
          },
        };
      } catch (error) {
        if (isMissingReferenceTable(error)) {
          return { isError: true, content: [{ type: "text" as const, text: MISSING_REFERENCES_MESSAGE }] };
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          isError: true,
          content: [{ type: "text" as const, text: `add_reference failed: ${message}` }],
        };
      }
    }
  );
}
