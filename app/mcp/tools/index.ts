import { registerEchoTool } from "./echo";
import { registerSearchDocsTool } from "./search-docs";
import { registerGetTimeApp } from "../mcpApps/get-time-app";
import { registerSearchGraphTool } from "./search-graph";

export function registerAllTools(server: any): void {
  registerEchoTool(server);
  registerSearchDocsTool(server);
  registerGetTimeApp(server);
  registerSearchGraphTool(server);
}