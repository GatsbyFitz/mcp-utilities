import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { registerAllTools } from "./tools";

export const runtime = "edge"; 
export const maxDuration = 60;

function createRequestScopedServer(): McpServer {
  const server = new McpServer({ 
    name: "nextjs-vercel-mcp-server", 
    version: "1.0.0" 
  });
  
  registerAllTools(server);
  return server;
}

export async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return createCorsResponse(new Response(null, { status: 204 }));
  }

  const sessionId = request.headers.get("mcp-session-id") || crypto.randomUUID();

  // Parse the current JSON-RPC request intent
  let rpcMethod = "unknown";
  if (request.method === "POST") {
    try {
      const clonedRequest = request.clone();
      const body = await clonedRequest.json();
      rpcMethod = body?.method ?? "unknown";
    } catch {
      rpcMethod = "invalid-json";
    }
  }

  const server = createRequestScopedServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId
  });

  // CRITICAL STEP: Prevent the serverless runtime from rejecting uninitialized states
  // We explicitly bind the target tracking configuration property onto the dynamic payload transport
  const targetTransport = (transport as any)._webStandardTransport || transport;
  if (targetTransport) {
    targetTransport.sessionId = sessionId;
    
    // If the client is sending anything other than the raw 'initialize' command,
    // we bypass the verification checks by declaring it pre-initialized.
    if (rpcMethod !== "initialize") {
      targetTransport._initialized = true;
    }
  }

  await server.connect(transport);
  const response = await transport.handleRequest(request);

  return createCorsResponse(response);
}

function createCorsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version, authorization");
  headers.set("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS };
