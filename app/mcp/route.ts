import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { registerAllTools } from "./tools";

function buildServer(): McpServer {
const server = new McpServer({ name: "nextjs-mcp-server", version: "1.0.0" });
registerAllTools(server);
return server;
}

const server = buildServer();
const transport = new WebStandardStreamableHTTPServerTransport({
sessionIdGenerator: undefined,
});
const ready = server.connect(transport);

async function handler(request: Request): Promise<Response> {
await ready;

const startedAt = Date.now();
let rpcMethod = "unknown";
let rpcId: string | number | null = null;

if (request.method === "POST") {
try {
const bodyText = await request.clone().text();
if (bodyText) {
const body = JSON.parse(bodyText);
rpcMethod = typeof body?.method === "string" ? body.method : "non-request-payload";
rpcId = body?.id ?? null;
      } else {
rpcMethod = "empty-body";
      }
    } catch {
rpcMethod = "invalid-json";
    }
  } else {
rpcMethod = "http-" + request.method.toLowerCase();
  }

console.log(
"[mcp:req]",
JSON.stringify({
method: request.method,
rpcMethod,
rpcId,
sessionId: request.headers.get("mcp-session-id"),
protocolVersion: request.headers.get("mcp-protocol-version"),
accept: request.headers.get("accept"),
    })
  );

const response = await transport.handleRequest(request);

// FIX: Remove the invalid webrtc CSP directive
const newHeaders = new Headers(response.headers);
const csp = newHeaders.get("Content-Security-Policy") || "";
const cleanedCsp = csp.replace(/webrtc[^;]*/g, "").trim();
if (cleanedCsp) {
newHeaders.set("Content-Security-Policy", cleanedCsp);
} else {
newHeaders.delete("Content-Security-Policy");
}

const cleanedResponse = new Response(response.body, {
status: response.status,
statusText: response.statusText,
headers: newHeaders,
});

console.log(
"[mcp:res]",
JSON.stringify({
method: request.method,
rpcMethod,
rpcId,
status: cleanedResponse.status,
durationMs: Date.now() - startedAt,
contentType: cleanedResponse.headers.get("content-type"),
    })
  );

return cleanedResponse;
}

export const maxDuration = 60;
export { handler as GET, handler as POST, handler as DELETE };