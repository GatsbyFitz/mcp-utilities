import type { McpServer } from "@modelcontextprotocol/server";
import { registerEchoTool } from "./echo";
import { registerSearchDocsTool } from "./search-docs";
import { registerLogoTool } from "./logo";

export function registerAllTools(server: McpServer): void {
  registerEchoTool(server);
  registerSearchDocsTool(server);
  registerLogoTool(server);
}