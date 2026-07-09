import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { vectorIndex } from "@/lib/vector";
import { embed } from "ai";

const handler = createMcpHandler(
  async (server) => {
    server.tool(
      "echo",
      "Echo a message",
      { message: z.string().min(1).max(100) },
      async ({ message }) => ({
        content: [{ type: "text", text: `Tool echo: ${message}` }],
      })
    );
    server.tool(
      "echo2",
      "Echo a message",
      { message: z.string().min(1).max(100) },
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
    disableSse: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };