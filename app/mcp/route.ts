import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "./tools";

const baseHandler = createMcpHandler((server) => {
  registerAllTools(server);
});

async function handler(req: Request) {
  const response = await baseHandler(req);
  
  const text = await response.text();
  
  const newResponse = new Response(text, {
    status: response.status,
    statusText: response.statusText,
  });
  
  for (const [key, value] of response.headers) {
    const lowerKey = key.toLowerCase();
    if (!lowerKey.includes("content-security-policy")) {
      newResponse.headers.set(key, value);
    }
  }
  
  return newResponse;
}

export { handler as GET, handler as POST, handler as DELETE };