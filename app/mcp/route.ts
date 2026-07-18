import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "./tools";

const baseHandler = createMcpHandler((server) => {
  registerAllTools(server);
});

async function handler(req: Request) {
  const response = await baseHandler(req);
  
  // Clone the response instead of converting to text
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
  });
  
  // Copy headers except CSP
  for (const [key, value] of response.headers) {
    const lowerKey = key.toLowerCase();
    if (!lowerKey.includes("content-security-policy")) {
      newResponse.headers.set(key, value);
    }
  }
  
  return newResponse;
}

export { handler as GET, handler as POST, handler as DELETE };