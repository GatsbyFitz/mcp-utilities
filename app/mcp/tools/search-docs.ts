import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { embed } from "ai";
import { vectorIndex } from "@/lib/vector";

export function registerSearchDocsTool(server: McpServer): void {
  server.registerTool(
    "search_docs",
    {
      title: "search_docs",
      description: "Search uploaded document chunks using semantic vector search.",
      inputSchema: z.object({
        query: z.string().min(2).max(1000),
        topK: z.number().int().min(1).max(10).default(5),
      }),
    },
    async ({ query, topK }) => {
      const { embedding } = await embed({
        model: "google/gemini-embedding-2",
        value: query,
        providerOptions: { google: { outputDimensionality: 1536 } },
      });

      const matches = await vectorIndex.query({
        vector: embedding,
        topK,
        includeMetadata: true,
        includeVectors: false,
      });

      return {
        content: [
          {
            type: "text",
            text: "Found " + matches.length + " matching chunks.",
          },
        ],
        structuredContent: {
          matches: matches.map((m) => {
            const md = (m.metadata ?? {}) as {
              text?: string;
              source?: string;
              chunkIndex?: number;
              citationId?: string;
              blobUrl?: string;
            };
            return {
              id: md.citationId ?? m.id,
              score: m.score,
              source: md.source ?? "unknown",
              chunkIndex: md.chunkIndex ?? null,
              text: md.text ?? "",
              referenceUrl: md.blobUrl ?? null,
            };
          }),
        },
      };
    }
  );
}