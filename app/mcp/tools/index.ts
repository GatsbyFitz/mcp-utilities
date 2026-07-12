import type { McpServer } from "@modelcontextprotocol/server";
import { registerEchoTool } from "./echo";
import { registerSearchDocsTool } from "./search-docs";

export function registerAllTools(server: McpServer): void {
  registerEchoTool(server);
  registerSearchDocsTool(server);
}