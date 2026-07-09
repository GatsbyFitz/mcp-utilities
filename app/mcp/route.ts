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
      "echo2",
      {
        title: "echo2",
        description: "Echo a message",
        inputSchema: z.object({
          message: z.string().min(1).max(100),
        }),
      },
      async ({ message }) => ({
        content: [{ type: "text", text: `Tool echo: ${message}` }],
      })
    );
  
  },
  {},
  {
    basePath: "",
    verboseLogs: true,
    maxDuration: 800,
    redisUrl: process.env.KV_URL,
  }
);

export { handler as GET, handler as POST, handler as DELETE };