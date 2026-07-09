import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { vectorIndex } from "@/lib/vector";
import { embed } from "ai";

const handler = createMcpHandler(
  async (server) => {
    server.registerTool(
      "echo",
      {
        title: "echo",
        description: "Echo a message",
        inputSchema: z.object({
          message: z.string().min(1).max(100),
        }),
      },
      async ({ message }) => ({
        content: [{ type: "text", text: `Tool echo: ${message}` }],
      })
    );

    server.registerTool(
      "search_docs",
      {
        title: "Search Documents",
        description: "Search the RAG database to answer questions using uploaded documents",
        inputSchema: z.object({
          query: z.string().min(1).max(500),
        }),
      },
      async ({ query }) => {
        const { embedding } = await embed({
          model: "google/gemini-embedding-2",
          value: query,
          providerOptions: {
            google: { outputDimensionality: 1536 },
          },
        });

        const results = await vectorIndex.query({
          vector: embedding,
          topK: 5,
          includeMetadata: true,
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No relevant documents found." }] };
        }

        const context = results
          .map((r, i) => `[${i + 1}] (source: ${(r.metadata as { source: string }).source})\n${(r.metadata as { text: string }).text}`)
          .join("\n\n");

        return { content: [{ type: "text", text: context }] };
      }
    );
  },
  {},
  {
    basePath: "",
    verboseLogs: true,
    maxDuration: 60,
    disableSse: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };