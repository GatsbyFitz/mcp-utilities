import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "./tools";

const baseHandler = createMcpHandler((server) => {
  registerAllTools(server);
});

async function handler(req: Request) {
  const response = await baseHandler(req);
  
  // Clone response to modify headers
  const newResponse = new Response(response.body, response);
  
  // Remove problematic CSP directives
  const csp = newResponse.headers.get("content-security-policy");
  if (csp) {
    const fixedCsp = csp
      .split(";")
      .filter(directive => {
        const trimmed = directive.trim();
        return !trimmed.startsWith("base-uri") && 
               !trimmed.startsWith("webrtc");
      })
      .join(";");
    
    newResponse.headers.set("content-security-policy", fixedCsp);
  }
  
  return newResponse;
}

export { handler as GET, handler as POST, handler as DELETE };