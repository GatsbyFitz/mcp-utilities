import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { baseURL } from "@/baseUrl"

import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

const resourceUri = "ui://get-time/mcp-app-v13.html";

async function fetchPageHtml(path: string): Promise<string> {
  const res = await fetch(`${baseURL}${path}`, { headers: { "Content-Type": "text/html" } });
  return res.text();
}


export function registerGetTimeApp(server: any): void {
  
registerAppResource(
  server,
  "app-widget",
  resourceUri,
  { mimeType: RESOURCE_MIME_TYPE },
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
                connectDomains: [baseURL],
                resourceDomains: [baseURL],
              },
            },
          },
        },
      ],
    };
  },
);

registerAppTool(
  server,
  "greet",
  {
    title: "Greet",
    description: "Display a personalised greeting in the widget.",
    inputSchema: {
      name: z.string().describe("Name of the person to greet"),
    },
    _meta: {
      ui: { resourceUri: resourceUri },
    },
  },
  async ({ name }) => ({
    content: [{ type: "text" as const, text: `Hello, ${name}!` }],
    structuredContent: {
      name,
      greeting: `Hello, ${name}!`,
      timestamp: new Date().toISOString(),
    },
  }),
);
  
}
