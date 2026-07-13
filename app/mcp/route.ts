import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { registerAllTools } from "./tools";

// 1. FORCE EDGE RUNTIME (Disables Vercel response buffering)
export const runtime = "edge"; 
export const maxDuration = 60;

// Helper to configure a clean, deterministic instance per request
function createRequestScopedServer(): McpServer {
  const server = new McpServer({ 
    name: "nextjs-vercel-mcp-server", 
    version: "1.0.0" 
  });
  
  // Register your tools safely
  registerAllTools(server);
  return server;
}

async function handler(request: Request): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id") || crypto.randomUUID();

  // 2. Identify the RPC execution intent before binding state
  let rpcMethod = "unknown";
  if (request.method === "POST") {
    try {
      const body = await request.clone().json();
      rpcMethod = body?.method ?? "non-request-payload";
    } catch {
      rpcMethod = "invalid-json";
    }
  } else {
    rpcMethod = `http-${request.method.toLowerCase()}`;
  }

  // 3. Create isolated server and transport bindings for this network call
  const server = createRequestScopedServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId
  });

  const innerTransport = (transport as any)._webStandardTransport || transport;
  if (innerTransport) {
    innerTransport.sessionId = sessionId;
    // Bypasses local initialization errors for downstream stateless operations
    innerTransport._initialized = (rpcMethod !== "initialize");
  }

  // Bind the runtime instance
  await server.connect(transport);

  console.log(`[mcp:vercel] Method: ${request.method} | RPC: ${rpcMethod} | Session: ${sessionId}`);

  // 4. Process request execution natively
  const response = await transport.handleRequest(request);

  // 5. Inject hard security headers for sandboxed browser runtimes
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version, authorization");

  return response;
}

// Ensure cross-origin preflight requests exit cleanly without executing protocol logic
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, mcp-protocol-version, authorization",
    },
  });
}

export { handler as GET, handler as POST, handler as DELETE };
