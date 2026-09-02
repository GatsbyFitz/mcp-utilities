import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { embed, rerank } from "ai";
import { WeightingStrategy } from "@upstash/vector";
import { vectorIndex } from "@/lib/vector";
import type { ChunkMetadata } from "@/lib/citations";
import { toCitation, citationLine, sourceList } from "@/lib/citations";
import { sparseVector } from "@/lib/sparse";


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

        const { ranking } = await rerank({
          model: "cohere/rerank-v3.5",
          query,
          documents: candidates.map((c) => c.text),
          topN: Math.min(topN, candidates.length),
        });

        const results = ranking.map((r, i) => ({
          n: i + 1,
          ...candidates[r.originalIndex],
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