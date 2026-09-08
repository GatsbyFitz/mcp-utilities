import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { embed, rerank } from "ai";
import { WeightingStrategy } from "@upstash/vector";
import { vectorIndex } from "@/lib/vector";
import type { ChunkMetadata } from "@/lib/citations";
import { toCitation, citationLine, sourceList } from "@/lib/citations";
import { sparseVector } from "@/lib/sparse";


// The rerank provider rejects any single document longer than 32,000 with a
// validation error that fails the *whole* call, not just that document — so
// one oversized candidate takes the entire search down, deterministically,
// for every query that happens to retrieve it.
//
// Chunks are normally ~2,000 characters, but `chunkTextWithPages` never splits
// a table internally (splitting one would change what it means), so `size` is
// a packing budget that a large table bypasses: a 400-row obligations table
// measures ~58,000 characters in one chunk. That is by design at ingestion and
// is not a chunking-invariant violation — both steps still chunk identically —
// but it means the reranker must not be handed raw chunk text.
const RERANK_MAX_CHARS = 30_000;

/**
 * Truncates only what is sent to the reranker. The full text is still what
 * gets rendered and cited, because the head of a chunk is enough to judge
 * relevance — and dropping the candidate instead would silently hide exactly
 * the big reference table the query was most likely aiming at.
 */
function capForRerank(text: string): string {
  let capped = text.length > RERANK_MAX_CHARS ? text.slice(0, RERANK_MAX_CHARS) : text;
  // The provider counts the limit on its own side and may count bytes rather
  // than characters, so shrink until it fits either reading instead of
  // guessing which one applies.
  const encoder = new TextEncoder();
  while (capped.length > 0 && encoder.encode(capped).length > RERANK_MAX_CHARS) {
    capped = capped.slice(0, Math.floor(capped.length * 0.9));
  }
  return capped;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerSearchDocsTool(server: McpServer): void {
  server.registerTool(
    "search_docs",
    {
      title: "search_docs",
      description:
        "Search uploaded document chunks using hybrid search (semantic vector " +
        "search combined with exact-term matching, e.g. document codes and " +
        "IDs like 'IN008-24'), then rerank the candidates for relevance. " +
        "Results are numbered [1], [2], " +
        "... with a citation header per result. When answering from these " +
        "results, cite claims using the document title, version, and page " +
        "range (e.g. 'Metering Provider Services SLP v2.0, pp. 10\u201311'), " +
        "and include each document's URL at most once. If no URL is present " +
        "for a document, say so rather than inventing one.",
      inputSchema: z.object({
        query: z.string().min(2).max(1000),
        topK: z.number().int().min(1).max(100).default(25),
        topN: z.number().int().min(1).max(50).default(8),
      }),
    },
    async ({ query, topK, topN }) => {
      try {
        const { embedding } = await embed({
          model: "google/gemini-embedding-2",
          value: `task: search result | query: ${query}`,
          providerOptions: { google: { outputDimensionality: 1536, taskType: "RETRIEVAL_QUERY" } },
        });

        const matches = await vectorIndex.query({
          vector: embedding,
          sparseVector: sparseVector(query),
          weightingStrategy: WeightingStrategy.IDF,
          topK,
          includeMetadata: true,
          includeVectors: false,
        });

        if (!Array.isArray(matches) || matches.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No matching chunks found for "${query}".`,
              },
            ],
            structuredContent: { query, results: [] },
          };
        }

        const candidates = matches.map((m) => {
          const md = (m.metadata ?? {}) as ChunkMetadata;
          const citation = toCitation(md);
          return {
            id: md.citationId ?? m.id,
            vectorScore: m.score,
            citation,
            text: md.text ?? "",
          };
        });

        // A chunk with no text cannot be reranked and the provider rejects an
        // empty document, so filter first and rank the survivors — `ranking`
        // indexes into whatever array was sent, not into `candidates`.
        const rerankable = candidates.filter((c) => c.text.trim().length > 0);

        if (rerankable.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Found ${candidates.length} matching chunks for "${query}", but ` +
                  `none carry indexed text. The document may need re-embedding.`,
              },
            ],
            structuredContent: { query, results: [] },
          };
        }

        const { ranking } = await rerank({
          model: "cohere/rerank-v3.5",
          query,
          documents: rerankable.map((c) => capForRerank(c.text)),
          topN: Math.min(topN, rerankable.length),
        });

        const results = ranking.map((r, i) => ({
          n: i + 1,
          ...rerankable[r.originalIndex],
          score: r.score,
        }));

        // Compact, model-friendly rendering. Models cite what they can read;
        // a numbered list with a citation header per result beats raw JSON.
        const rendered = results
          .map(
            (r) =>
              `${citationLine(r.n, r.citation, r.score)}\n${r.text.trim()}`
          )
          .join("\n\n---\n\n");

        // Deduplicated source list, rendered as Markdown links by lib/citations
        // so every tool emits the same clickable format.
        const sources = sourceList(results.map((r) => r.citation));

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Found ${results.length} matching chunks for "${query}".\n\n` +
                `${rendered}\n\nSources:\n${sources}`,
            },
          ],
          structuredContent: { query, results },
        };
      } catch (err) {
        // Surface failures explicitly instead of silently returning a bare
        // count \u2014 this is likely what caused the earlier "Found 5 matching
        // chunks." responses with no payload.
        const message =
          err instanceof Error ? err.message : "Unknown search error";
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `search_docs failed: ${message}`,
            },
          ],
        };
      }
    }
  );
}