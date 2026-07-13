import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { registerAllTools } from "./tools";

function buildServer(): McpServer {
  const server = new McpServer({ name: "nextjs-mcp-server", version: "1.0.0" });
  registerAllTools(server);
  return server;
}

const server = buildServer();

async function handler(request: Request): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id") || crypto.randomUUID();

  // 1. Parse the RPC method safely without consuming the main stream
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

  // 2. Instantiate a request-scoped transport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId
  });

  // 3. DYNAMIC REHYDRATION BOUNDARY
  // Safely grab the internal standard transport engine
  const innerTransport = (transport as any)._webStandardTransport || transport;
  
  if (innerTransport) {
    innerTransport.sessionId = sessionId;
    
    if (rpcMethod === "initialize") {
      // Let the SDK perform the natural initialization workflow
      innerTransport._initialized = false; 
    } else {
      // Force initialization state ONLY for downstream tool/app execution
      innerTransport._initialized = true; 
    }
  }

  // 4. Connect and process
  await server.connect(transport);

  console.log(`[mcp:req] Method: ${request.method} | RPC: ${rpcMethod} | Session: ${sessionId}`);

  const response = await transport.handleRequest(request);

  // 5. Inject full CORS headers for interactive client frames
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version");

  return response;
}

export const maxDuration = 60;

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, mcp-protocol-version",
    },
  });
}

export { handler as GET, handler as POST, handler as DELETE };
