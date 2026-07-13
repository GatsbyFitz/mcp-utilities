import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "./tools";

const handler = createMcpHandler((server) => {
  registerAllTools(server);
});



export { handler as GET, handler as POST, handler as DELETE };