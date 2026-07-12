import type { McpServer } from "@modelcontextprotocol/server";
import { registerEchoTool } from "./echo";
import { registerSearchDocsTool } from "./search-docs";
import { registerUtilitiesLogoApp } from "../mcpApps/logo-app";

export function registerAllTools(server: McpServer): void {
  registerEchoTool(server);
  registerSearchDocsTool(server);
  registerUtilitiesLogoApp(server);
}