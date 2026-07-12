import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

export function registerEchoTool(server: McpServer): void {
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
}