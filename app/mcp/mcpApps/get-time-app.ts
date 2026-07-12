import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod"; 
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

// Keep this static and stable so it never breaks on server restarts
const resourceUri = "ui://get-time/static-app.html"; 
const resourceUriMetaKey = "ui/resourceUri";

export function registerGetTimeApp(server: McpServer): void {
  
  // 1. Static Resource Shell
  server.registerResource(
    "get-time-app-ui",
    resourceUri,
    {
      title: "Get Time App UI",
      description: "Static UI container displaying a localized runtime clock.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => {
      // Inlined HTML completely removes the need for fetch() or VERCEL_HOME_URL
      const htmlPayload = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Static Get Time App</title>
          <style>
            body { 
              font-family: system-ui, -apple-system, sans-serif; 
              padding: 16px; 
              background: #111111; 
              color: #ffffff; 
              margin: 0;
              display: flex;
              justify-content: center;
            }
            .card { 
              border: 1px solid #2a2a2a; 
              padding: 20px; 
              border-radius: 12px; 
              background: #1a1a1a; 
              width: 100%;
              max-width: 260px; 
              text-align: center;
            }
            h1 { margin: 0 0 12px 0; font-size: 1.1rem; color: #a78bfa; text-transform: uppercase; }
            #time-display { font-family: monospace; font-size: 1.75rem; font-weight: bold; color: #34d399; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Local System Clock</h1>
            <div id="time-display">00:00:00</div>
          </div>

          <script>
            function updateClock() {
              document.getElementById("time-display").innerText = new Date().toLocaleTimeString();
            }
            updateClock();
            setInterval(updateClock, 1000);

            // Mandatory handshake so the host knows the canvas is ready to render
            window.parent.postMessage({ type: "mcp-app-ready" }, "*");
          </script>
        </body>
        </html>
      `;

      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: htmlPayload,
            _meta: {
              ui: {
                // Empty CSP structures are fine since there are zero external connections
                csp: {
                  connectDomains: [],
                  resourceDomains: [],
                },
              },
            },
          },
        ],
      };
    }
  );

  // 2. Simple Tool Gateway
  server.registerTool(
    "get_time_app",
    {
      title: "Get Time",
      description: "Launches the client-side clock layout.",
      inputSchema: z.object({}),
      _meta: {
        ui: { resourceUri },
        [resourceUriMetaKey]: resourceUri,
      },
    },
    async () => {
      return {
        content: [{ type: "text", text: "Opening the isolated static widget panel..." }],
        structuredContent: {}, // Passing an empty object prevents token bloat
      };
    }
  );
}
