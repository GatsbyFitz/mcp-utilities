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
      async ({ query }) => ({
        content: [{ type: "text", text: `Search received: ${query}` }],
      })
    );
  },
  {},
  {
    basePath: "",
    verboseLogs: true,
    maxDuration: 800,
    disableSse: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };