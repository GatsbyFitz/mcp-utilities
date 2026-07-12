import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod"; // Fixed version syntax import block

const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const resourceUri = "ui://get-time/mcp-app-v4.html";
const resourceUriMetaKey = "ui/resourceUri";


const VERCEL_HOME_URL = "https://mcp-utilities.vercel.app";

async function fetchPageHtml(path: string): Promise<string> {
  const res = await fetch(`${VERCEL_HOME_URL}${path}`);
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
      const html = await fetchPageHtml("/");
      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: {
                  connectDomains: [VERCEL_HOME_URL],
                  resourceDomains: [VERCEL_HOME_URL],
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
