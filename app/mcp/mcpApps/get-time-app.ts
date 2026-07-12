import type { McpServer } from "@modelcontextprotocol/server";
import fs from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const resourceUri = "ui://get-time/mcp-app-v4.html";
const resourceUriMetaKey = "ui/resourceUri";

const DIST_DIR = path.join(process.cwd(), "app", "mcp", "mcpApps", "dist");


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
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
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