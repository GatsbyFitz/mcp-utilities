import { registerEchoTool } from "./echo";
import { registerSearchDocsTool } from "./search-docs";
import { registerGetTimeApp } from "../apps/get-time-app";
import { registerSearchGraphTool } from "./search-graph";

export function registerAllTools(server: any): void {
  registerEchoTool(server);
  registerSearchDocsTool(server);
  registerSearchGraphTool(server);
}