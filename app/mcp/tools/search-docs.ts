import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { embed } from "ai";
import { vectorIndex } from "@/lib/vector";

// ---------------------------------------------------------------------------
// Metadata normalization
// ---------------------------------------------------------------------------

interface ChunkMetadata {
  text?: string;
  source?: string;
  chunkIndex?: number;
  citationId?: string;
  blobUrl?: string;
  blobDownloadUrl?: string;
  // Present if you enrich at ingestion (recommended):
  title?: string;
  version?: string;
  publisher?: string;
  effectiveDate?: string;
}

interface Citation {
  title: string;
  version: string | null;
  publisher: string | null;
  pages: string | null;
  url: string | null;
  source: string;
  chunkIndex: number | null;
}

/** "service-level-procedure-mp-services-v20.pdf" -> "Service Level Procedure Mp Services V20" */
function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.(pdf|docx?|txt|md)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Extract page range from "----------------Page (N) Break----------------" markers in chunk text. */
function pageRange(text: string): string | null {
  const pages = [...text.matchAll(/Page \((\d+)\) Break/g)].map((m) =>
    parseInt(m[1], 10)
  );
  if (pages.length === 0) return null;
  const min = Math.min(...pages);
  const max = Math.max(...pages);
  // Page markers are 0-indexed breaks; content spans from before the first
  // marker to after the last, so report as printed pages (1-indexed).
  return min === max ? `p. ${min + 1}` : `pp. ${min + 1}\u2013${max + 2}`;
}

function toCitation(md: ChunkMetadata): Citation {
  return {
    title: md.title ?? titleFromFilename(md.source ?? "unknown"),
    version: md.version ?? null,
    publisher: md.publisher ?? null,
    pages: md.text ? pageRange(md.text) : null,
    url: md.blobUrl ?? null,
    source: md.source ?? "unknown",
    chunkIndex: md.chunkIndex ?? null,
  };
}

/** "[1] Title (v2.0, pp. 10-11) — score 0.74" */
function citationLine(n: number, c: Citation, score: number): string {
  const parts = [c.version ? `v${c.version}` : null, c.pages].filter(Boolean);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  return `[${n}] ${c.title}${detail} \u2014 relevance ${score.toFixed(2)}`;
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
        "Search uploaded document chunks using semantic vector search. " +
        "Results are numbered [1], [2], ... with a citation header per result. " +
        "When answering from these results, cite claims using the document " +
        "title, version, and page range (e.g. 'Metering Provider Services SLP " +
        "v2.0, pp. 10\u201311'), and include each document's URL at most once. " +
        "If no URL is present for a document, say so rather than inventing one.",
      inputSchema: z.object({
        query: z.string().min(2).max(1000),
        topK: z.number().int().min(1).max(10).default(5),
      }),
    },
    async ({ query, topK }) => {
      try {
        const { embedding } = await embed({
          model: "google/gemini-embedding-2",
          value: `task: search result | query: ${query}`,
          providerOptions: { google: { outputDimensionality: 1536, taskType: "RETRIEVAL_QUERY" } },
        });

        const matches = await vectorIndex.query({
          vector: embedding,
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

        const results = matches.map((m, i) => {
          const md = (m.metadata ?? {}) as ChunkMetadata;
          const citation = toCitation(md);
          return {
            n: i + 1,
            id: md.citationId ?? m.id,
            score: m.score,
            citation,
            text: md.text ?? "",
          };
        });

        // Compact, model-friendly rendering. Models cite what they can read;
        // a numbered list with a citation header per result beats raw JSON.
        const rendered = results
          .map(
            (r) =>
              `${citationLine(r.n, r.citation, r.score)}\n${r.text.trim()}`
          )
          .join("\n\n---\n\n");

        // Deduplicated source list with URLs, once per document.
        const sources = [
          ...new Map(
            results.map((r) => [r.citation.source, r.citation])
          ).values(),
        ]
          .map(
            (c) =>
              `- ${c.title}${c.version ? ` v${c.version}` : ""}: ${
                c.url ?? "no URL in index"
              }`
          )
          .join("\n");

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