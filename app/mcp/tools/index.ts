import { registerEchoTool } from "./echo";
import { registerSearchDocsTool } from "./search-docs";
import { registerSearchGraphTool } from "./search-graph";
import { registerRequestDocumentTool } from "./request-document";
import { registerSearchComplianceTool } from "./search-compliance";
import { registerSearchAerPerformanceTool } from "./search-aer-performance";
import { registerReadReferenceTool } from "./read-reference";

export function registerAllTools(server: any): void {
  registerEchoTool(server);
  registerSearchDocsTool(server);
  registerSearchGraphTool(server);
  registerRequestDocumentTool(server);
  registerSearchComplianceTool(server);
  registerSearchAerPerformanceTool(server);
  registerReadReferenceTool(server);
}