import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { embed } from "ai";
import { vectorIndex } from "@/lib/vector";

function buildServer(): McpServer {
  const server = new McpServer({ name: "nextjs-mcp-server", version: "1.0.0" });

  server.registerTool(
    "echo",
    {
      title: "echo",
      description: "Echo a message",
      inputSchema: z.object({ message: z.string().min(1).max(100) }),
    },
    async ({ message }) => ({
      content: [{ type: "text", text: "Tool echo: " + message }],
    })
  );

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
        providerOptions: {
          google: {
            outputDimensionality: 1536,
          },
        },
      });

      const matches = await vectorIndex.query({
        vector: embedding,
        topK,
        includeMetadata: true,
        includeVectors: false,
      });

      if (!matches.length) {
        return {
          content: [{ type: "text", text: "No matching document chunks found." }],
          structuredContent: { matches: [] },
        };
      }

      const normalized = matches.map((m) => {
        const md = (m.metadata ?? {}) as {
          text?: string;
          source?: string;
          chunkIndex?: number;
        };

        return {
          score: m.score,
          source: md.source ?? "unknown",
          chunkIndex: md.chunkIndex ?? null,
          text: md.text ?? "",
        };
      });

      const summary = normalized
        .map((m, i) => {
          const score = typeof m.score === "number" ? m.score.toFixed(4) : String(m.score);
          const preview = m.text.length > 450 ? m.text.slice(0, 450) + "..." : m.text;
          return [
            i + 1 + ".",
            "score: " + score,
            "source: " + m.source,
            "chunk: " + String(m.chunkIndex),
            preview,
          ].join("\n");
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: 'Top ' + normalized.length + ' matches for "' + query + '":\n\n' + summary,
          },
        ],
        structuredContent: { matches: normalized },
      };
    }
  );

  return server;
}

const server = buildServer();
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});
const ready = server.connect(transport);

async function handler(request: Request): Promise<Response> {
  await ready;
  return transport.handleRequest(request);
}

export const maxDuration = 60;
export { handler as GET, handler as POST, handler as DELETE };