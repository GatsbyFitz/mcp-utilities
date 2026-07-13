import { baseURL } from "@/baseUrl";
import { createMcpHandler } from "mcp-handler";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

const UI_VERSION = "2026-02-10-21";
const RESOURCE_URI = `ui://app/index.html?v=${UI_VERSION}`;

// ---------------------------------------------------------------------------
// Self-fetch: grab the rendered Next.js page to use as the widget HTML.
// ---------------------------------------------------------------------------
async function fetchPageHtml(path: string): Promise<string> {
  const res = await fetch(`${baseURL}${path}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// MCP handler
// ---------------------------------------------------------------------------
const handler = createMcpHandler(async (server) => {
  registerAppResource(
    server,
    "app-widget",
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = await fetchPageHtml("/");
      return {
        contents: [
          {
            uri: RESOURCE_URI,
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: RESOURCE_URI },
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
});

export const GET = handler;
export const POST = handler;