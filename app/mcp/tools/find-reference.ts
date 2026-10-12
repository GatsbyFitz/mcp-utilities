import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { embed } from "ai";
import { WeightingStrategy } from "@upstash/vector";
import { vectorIndex } from "@/lib/vector";
import { sparseVector } from "@/lib/sparse";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import {
  MAX_REFERENCE_RESULTS,
  MISSING_REFERENCES_MESSAGE,
  REFERENCE_KIND,
  isMissingReferenceTable,
  type ReferenceMatch,
} from "@/lib/references";
import { listReferences } from "@/lib/referenceStore";

// ---------------------------------------------------------------------------
// find_reference — a router, not a retriever
// ---------------------------------------------------------------------------
// Every other search tool here answers a question. This one answers "where
// should I look", and hands back a URL for the caller to open itself.
//
// That split exists because these pages fail differently from the corpus. API
// documentation versions, and a moved endpoint reads exactly like a working
// one — so an indexed copy of the text is a confident lie. What is indexed is
// a *descriptor* of what each page covers, which ages far more slowly, and the
// page is read live by whoever asked.
//
// It also puts the fetching where it works. This server frequently cannot
// reach the pages worth referencing — they render client-side, or are not
// resolvable from its network — while the client asking the question usually
// can. The server knows what exists and which of it is relevant; the client
// knows how to read a page. Neither can do the other's half.

function renderMatch(match: ReferenceMatch, n: number): string {
  const terms = match.keyTerms.length ? `\nCovers: ${match.keyTerms.join(", ")}` : "";
  return `[${n}] ${match.title}\n${match.url}\n${match.summary}${terms}`;
}

export function registerFindReferenceTool(server: McpServer): void {
  server.registerTool(
    "find_reference",
    {
      title: "find_reference",
      description:
        "Find which live reference page answers a question, and get its URL. " +
        "These are sources kept current rather than indexed — API " +
        "documentation and specifications, where being out of date is the " +
        "worst failure, because a moved endpoint looks exactly like a working " +
        "one. " +
        // The mechanism, stated rather than implied. A description that only
        // says "returns relevant URLs" gets treated as a reading list, and the
        // model answers from the summary — which describes what the page is
        // about, not what it says.
        "IMPORTANT: this returns pointers, not content. The summaries " +
        "describe what each page *covers*; they do not contain the answer. " +
        "You must fetch the returned URL yourself — with your own web " +
        "browsing or fetch capability — and answer from the live page. Do not " +
        "answer from the summary, and do not claim a page lacks something you " +
        "have not opened. If you cannot fetch URLs, say so and give the user " +
        "the link rather than guessing at its contents. " +
        "Use this for how to *call* an API, for current endpoints, schemas " +
        "and specifications. For what the market rules require, and for " +
        "anything needing a citation, use search_docs — these pages are not " +
        "in the document index and have no page citations.",
      inputSchema: z.object({
        question: z.string().min(2).max(1000),
      }),
    },
    async ({ question }) => {
      try {
        const { embedding } = await embed({
          model: EMBEDDING_MODEL,
          value: `task: search result | query: ${question}`,
          providerOptions: {
            google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: "RETRIEVAL_QUERY" },
          },
        });

        const matches = await vectorIndex.query({
          vector: embedding,
          // Same tokenisation as the document side, or term overlap silently
          // stops matching. Key terms like "MSATS" live or die on this half.
          sparseVector: sparseVector(question),
          weightingStrategy: WeightingStrategy.IDF,
          topK: MAX_REFERENCE_RESULTS,
          filter: `kind = '${REFERENCE_KIND}'`,
          includeMetadata: true,
          includeVectors: false,
        });

        // Read back from Postgres rather than trusting the vector metadata:
        // the row is the source of truth for the URL, and a descriptor edited
        // after indexing would otherwise be served from a stale copy.
        const names = (Array.isArray(matches) ? matches : []).map((m) =>
          String((m.metadata as { source?: unknown })?.source ?? "")
        );
        const scores = new Map(
          (Array.isArray(matches) ? matches : []).map((m) => [
            String((m.metadata as { source?: unknown })?.source ?? ""),
            m.score,
          ])
        );

        const all = await listReferences();
        const byName = new Map(all.map((r) => [r.name, r]));
        const found: ReferenceMatch[] = names
          .map((n) => byName.get(n))
          .filter((r): r is NonNullable<typeof r> => r !== undefined)
          .map((r) => ({ ...r, score: scores.get(r.name) ?? 0 }));

        if (found.length === 0) {
          // "Nothing matched" and "nothing is registered" must never read
          // alike: the first is an answer, the second is a setup gap.
          const text = all.length
            ? `No reference matches "${question}". Registered references:\n` +
              all.map((r) => `- ${r.title} — ${r.url}`).join("\n")
            : "No reference pages are registered yet, so there is nothing to " +
              "point at. This is not a statement about what documentation exists.";
          return { content: [{ type: "text" as const, text }], structuredContent: { question, references: [] } };
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                `${found.length} reference page(s) to open. Fetch the URL and ` +
                `answer from the live page — the summaries below say what each ` +
                `page covers, not what it contains.\n\n` +
                found.map(renderMatch).join("\n\n---\n\n"),
            },
          ],
          structuredContent: {
            question,
            references: found.map((r) => ({
              name: r.name,
              url: r.url,
              title: r.title,
              summary: r.summary,
              keyTerms: r.keyTerms,
              score: r.score,
            })),
          },
        };
      } catch (error) {
        if (isMissingReferenceTable(error)) {
          return { isError: true, content: [{ type: "text" as const, text: MISSING_REFERENCES_MESSAGE }] };
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          isError: true,
          content: [{ type: "text" as const, text: `find_reference failed: ${message}` }],
        };
      }
    }
  );
}
