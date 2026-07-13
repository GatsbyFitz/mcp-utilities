import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "./tools";

// Pass a configuration callback function instead of the raw McpServer object
const handler = createMcpHandler(
  (server) => {
    // This server instance is created and managed internally by the Vercel handler
    registerAllTools(server);
  },
  {}, // Middleware or options object (optional)
  {
    maxDuration: 60,
    basePath: ""
  }
);

export { handler as GET, handler as POST, handler as DELETE };
