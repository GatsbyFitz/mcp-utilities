import type { McpServer } from "@modelcontextprotocol/server";
import fs from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const resourceUri = "ui://get-time/mcp-app-v1.html";
const resourceUriMetaKey = "ui/resourceUri";

const DIST_DIR = path.join(process.cwd(), "app", "mcp", "mcpApps", "dist");

const fallbackHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Get Time App</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #111827; color: #f9fafb; }
    .card { max-width: 520px; margin: 0 auto; border: 1px solid #374151; border-radius: 12px; padding: 16px; background: #1f2937; }
    .time { font-size: 20px; font-weight: 700; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin:0;">Get Time App</h2>
    <p style="margin:8px 0 0 0;">If you see this, the UI resource loaded correctly.</p>
    <div class="time" id="time">Waiting for tool result...</div>
  </div>
  <script>
    // Static fallback display; host can still show tool text result.
    document.getElementById("time").textContent = new Date().toISOString();
  </script>
</body>
</html>`;

export function registerGetTimeApp(server: McpServer): void {
  server.registerResource(
    "get-time-app-ui",
    resourceUri,
    {
      title: "Get Time App UI",
      description: "Interactive UI for get-time tool",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (uri) => {
      let html = fallbackHtml;
      try {
        html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
      } catch {
        // Keep fallbackHtml when dist file is not present.
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
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