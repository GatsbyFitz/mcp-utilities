import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { registerAllTools } from "./tools";

// 1. Force Edge Runtime & Disable Response Buffering
export const runtime = "edge"; 
export const maxDuration = 60;

// Request-scoped server isolation matching vercel/mcp-handler lifecycle hooks
function createRequestScopedServer(): McpServer {
  const server = new McpServer({ 
    name: "nextjs-vercel-mcp-server", 
    version: "1.0.0" 
  });
  
  registerAllTools(server);
  return server;
}

// 2. Main Entry Point (Replicating vercel/mcp-handler/src/handler/mcp-api-handler.ts)
async function handler(request: Request): Promise<Response> {
  // Direct interception of browser/extension preflight rules
  if (request.method === "OPTIONS") {
    return createCorsResponse(new Response(null, { status: 204 }));
  }

  // Enforce session identifier strings
  const sessionId = request.headers.get("mcp-session-id") || crypto.randomUUID();

  // Instantiate clean sandbox structures
  const server = createRequestScopedServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId
  });

  // Bind server context
  await server.connect(transport);

  // Replicating Vercel's response execution block natively
  try {
    const response = await transport.handleRequest(request);
    return createCorsResponse(response);
  } catch (error) {
    console.error("[mcp:error]", error);
    return createCorsResponse(
      new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      })
    );
  }
}

// 3. Replicating vercel/mcp-handler/src/handler/server-response-adapter.ts
// Securely builds a new headers context map to prevent mutation frozen errors on edge runtimes
function createCorsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version, authorization");
  
  // Re-expose headers needed by specific local client apps (like Cursor/Claude Desktop)
  headers.set("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// Route assignments matching any incoming HTTP method profile cleanly
export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS };
