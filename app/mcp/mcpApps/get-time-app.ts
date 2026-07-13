import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { baseURL } from "@/baseUrl"
import {
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

const resourceUri = "ui://get-time/mcp-app-v16.html";

async function fetchPageHtml(path: string): Promise<string> {
  const res = await fetch(`${baseURL}${path}`);
  return res.text();
}


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
      const html = await fetchPageHtml("/test");
      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html, // Serves the bundle instantly
            _meta: {
              ui: {
                csp: {
                  connectDomains: [baseURL],  // Allow all domains (less secure)
                  resourceDomains: [baseURL],
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
        ui: { resourceUri: resourceUri },
      },
    },
    async () => {
      const time = new Date().toISOString();
      return {
        content: [{ type: "text" as const, text: time }],
        structuredContent: { time },
      };
    }
  );
}
