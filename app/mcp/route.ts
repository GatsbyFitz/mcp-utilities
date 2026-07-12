import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

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