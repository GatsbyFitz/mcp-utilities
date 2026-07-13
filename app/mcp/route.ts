import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "./tools";

const baseHandler = createMcpHandler((server) => {
  registerAllTools(server);
});

async function handler(req: Request) {
  const response = await baseHandler(req);
  
  // Clone response to modify headers
  const newResponse = new Response(response.body, response);

   // Remove the problematic CSP headers entirely
  newResponse.headers.delete("content-security-policy");
  newResponse.headers.delete("content-security-policy-report-only");
  
  return newResponse;
}

export { handler as GET, handler as POST, handler as DELETE };