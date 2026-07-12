import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { embed } from "ai";
import { vectorIndex } from "@/lib/vector";
import { registerAllTools } from "@/mcp/tools";

function buildServer(): McpServer {
  const server = new McpServer({ name: "nextjs-mcp-server", version: "1.0.0" });
  registerAllTools(server);
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