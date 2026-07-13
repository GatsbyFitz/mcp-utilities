import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { registerAllTools } from "./tools";

// 1. Enforce Edge Runtime (Necessary for high-performance serverless endpoints)
export const runtime = "edge"; 
export const maxDuration = 60;

// Dynamic request-scoped factory to enforce token/state isolation
function createV2ServerInstance(): McpServer {
  const server = new McpServer({ 
    name: "nextjs-vercel-mcp-server-v2", 
    version: "2.0.0" // Declare compliance with the modern v2 specification
  });
  
  registerAllTools(server);
  return server;
}

// 2. Main Protocol v2 HTTP Pipeline Entrypoint
async function handler(request: Request): Promise<Response> {
  // Catch browser cross-origin validation preflights instantly
  if (request.method === "OPTIONS") {
    return createCorsResponse(request, new Response(null, { status: 204 }));
  }

  // Parse session id tracking matrices
  const sessionId = request.headers.get("mcp-session-id") || crypto.randomUUID();

  // Safely extract the current JSON-RPC method parameter string using stream clones
  let rpcMethod = "unknown";
  if (request.method === "POST") {
    try {
      const requestClone = request.clone();
      const body = await requestClone.json();
      rpcMethod = body?.method ?? "unknown";
    } catch {
      rpcMethod = "invalid-json";
    }
  }

  try {
    const server = createV2ServerInstance();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId
    });

    // 3. Protocol v2 Serverless Initialization Bypass Patch
    const targetTransport = (transport as any)._webStandardTransport || transport;
    if (targetTransport) {
      targetTransport.sessionId = sessionId;
      // Triggers internal engines to trust the connection state for dynamic tool executions
      if (rpcMethod !== "initialize") {
        targetTransport._initialized = true;
      }
    }

    // Connect the stream mechanisms
    await server.connect(transport);
    const mcpResponse = await transport.handleRequest(request);

    // 4. Safe Buffer Streaming (Resolves 400 Bad Request Stream lock errors)
    const responseText = await mcpResponse.text();
    const payloadBuffer = new TextEncoder().encode(responseText);

    const targetHeaders = new Headers(mcpResponse.headers);
    targetHeaders.set("Content-Length", payloadBuffer.byteLength.toString());
    targetHeaders.set("Content-Type", "application/json");

    const optimizedResponse = new Response(payloadBuffer, {
      status: mcpResponse.status,
      statusText: mcpResponse.statusText,
      headers: targetHeaders
    });

    return createCorsResponse(request, optimizedResponse);

  } catch (error) {
    console.error("[mcp:v2-fatal-exception]", error);
    
    // Consistent v2 compliant fallback structural JSON-RPC error payload
    const fallbackPayload = JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal Server Error"
      },
      id: null
    });

    const errorBuffer = new TextEncoder().encode(fallbackPayload);

    return createCorsResponse(
      request,
      new Response(errorBuffer, {
        status: 500,
        headers: { 
          "Content-Type": "application/json",
          "Content-Length": errorBuffer.byteLength.toString()
        }
      })
    );
  }
}

// 5. Dynamic Cross-Origin (CORS) Mirror Adapter (Fixes iframe MessageEvent drops)
function createCorsResponse(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  
  // Read incoming request domain mapping strings
  const incomingOrigin = request.headers.get("Origin");
  
  // Dynamically mirror back the exact requesting frame origin instead of fallback "*" wildcards
  // This tricks Claude / ext-apps sandboxes into allowing dynamic postMessage operations
  if (incomingOrigin) {
    headers.set("Access-Control-Allow-Origin", incomingOrigin);
  } else {
    headers.set("Access-Control-Allow-Origin", "*");
  }

  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version, authorization");
  headers.set("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
  headers.set("Access-Control-Allow-Credentials", "true");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS };
