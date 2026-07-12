import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const resourceUri = "ui://get-time/mcp-app-v5.html";
const resourceUriMetaKey = "ui/resourceUri";

// Pure, self-contained single-file HTML delivery. 
// Bypasses file system lookups and Vercel network header blocks entirely.
const WIDGET_HTML_PAYLOAD = `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Get Time Widget</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 16px; margin: 0; background: #fff; }
      .card { border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
      h1 { font-size: 1.25rem; color: #1e293b; margin: 0 0 12px 0; }
      .time-box { font-size: 1.5rem; font-weight: 700; color: #2563eb; font-family: monospace; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Server Time Widget</h1>
      <div id="time-display" class="time-box">Initializing...</div>
    </div>
    <script>
      console.log("Vite Single-File App mounted securely inside Claude Sandbox.");
      
      function formatTime() {
        document.getElementById("time-display").innerText = new Date().toLocaleTimeString();
      }
      
      formatTime();
      setInterval(formatTime, 1000);
    </script>
  </body>
</html>
`;

export function registerGetTimeApp(server: McpServer): void {
  server.registerResource(
    "get-time-app-ui",
    resourceUri,
    {
      title: "Get Time App UI",
      description: "Interactive UI for get-time tool",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => {
      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: WIDGET_HTML_PAYLOAD, // Serves the bundle instantly
            _meta: {
              ui: {
                csp: {
                  connectDomains: ["*"],
                  resourceDomains: ["*"],
                  scriptSrc: ["'self'", "'unsafe-inline'"],
                  styleSrc: ["'self'", "'unsafe-inline'"]
                },
              },
            },
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_time_app",
    {
      title: "Get Time",
      description: "Returns current server time and opens app UI.",
      inputSchema: z.object({}),
      _meta: {
        ui: { resourceUri },
        [resourceUriMetaKey]: resourceUri,
      },
    },
    async () => {
      const time = new Date().toISOString();
      return {
        content: [{ type: "text", text: time }],
        structuredContent: { time },
      };
    }
  );
}
