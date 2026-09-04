import { registerEchoTool } from "./echo";
import { registerSearchDocsTool } from "./search-docs";
import { registerSearchGraphTool } from "./search-graph";
import { registerRequestDocumentTool } from "./request-document";

export function registerAllTools(server: any): void {
  registerEchoTool(server);
  registerSearchDocsTool(server);
  registerSearchGraphTool(server);
  registerRequestDocumentTool(server);
}