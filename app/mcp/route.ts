import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { registerAllTools } from "./tools";

export const maxDuration = 60;
export const runtime = "edge";

// Refactored to build the server architecture reliably inside the Vercel Edge environment
function buildServer(): McpServer {
  const server = new McpServer({ name: "nextjs-mcp-server", version: "1.0.0" });
  registerAllTools(server);
  return server;
}

async function handler(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let rpcMethod = "unknown";
  let rpcId: string | number | null = null;
  let parsedPayload: any = null;

  // 1. Capture session ID sent from the host/proxy, fallback to a fresh UUID
  const sessionId = request.headers.get("mcp-session-id") || crypto.randomUUID();

  // 2. Safely parse incoming POST JSON content 
  if (request.method === "POST") {
    try {
      const bodyText = await request.clone().text();
      if (bodyText) {
        parsedPayload = JSON.parse(bodyText);
        rpcMethod = typeof parsedPayload?.method === "string" ? parsedPayload.method : "non-request-payload";
        rpcId = parsedPayload?.id ?? null;
      } else {
        rpcMethod = "empty-body";
      }
    } catch {
      rpcMethod = "invalid-json";
    }
  } else {
    rpcMethod = "http-" + request.method.toLowerCase();
  }

  // 3. YOUR LOG [mcp:req] (Maintained with exact structural formatting)
  console.log(
    "[mcp:req]",
    JSON.stringify({
      method: request.method,
      rpcMethod,
      rpcId,
      sessionId: request.headers.get("mcp-session-id") || sessionId,
      protocolVersion: request.headers.get("mcp-protocol-version"),
      accept: request.headers.get("accept"),
    })
  );

  // 🔴 VERBOSE DEBUG LOG: Prints raw incoming JSON properties to terminal
  if (parsedPayload) {
    console.log("[MCP DEBUG INBOUND PAYLOAD]:", JSON.stringify(parsedPayload, null, 2));
  }

  // 4. Request-scoped instance layout to handle Vercel Edge's distributed routing states
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
  });

  // 5. Stateful rehydration boundary logic
  const innerTransport = (transport as any)._webStandardTransport || transport;
  if (innerTransport) {
    innerTransport.sessionId = sessionId;
    // Fixes down-stream initialization crashes, allows explicit 'initialize' calls to flow naturally
    innerTransport._initialized = (rpcMethod !== "initialize");
  }

  // Connect local instances
  await server.connect(transport);

  // Execute request
  const response = await transport.handleRequest(request);

  // 6. Inject standard CORS headers for browser frame and UI sandbox environments
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version");

  // 7. YOUR LOG [mcp:res] (Maintained with exact structural formatting)
  console.log(
    "[mcp:res]",
    JSON.stringify({
      method: request.method,
      rpcMethod,
      rpcId,
      status: response.status,
      durationMs: Date.now() - startedAt,
      contentType: response.headers.get("content-type"),
    })
  );

  // 🔴 VERBOSE DEBUG LOG: Catches and mirrors outgoing server payloads
  if (response.headers.get("content-type")?.includes("json")) {
    try {
      const debugRes = await response.clone().json();
      console.log("[MCP DEBUG OUTBOUND RESPONSE]:", JSON.stringify(debugRes, null, 2));
    } catch (e) {
      // Catch empty or non-JSON evaluation anomalies cleanly
    }
  }

  return response;
}

// Global OPTIONS route prevents CORS preflight requests from failing before reaching protocol hooks
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
