import { z } from "zod";
import { baseURL } from "@/baseUrl"
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";

const resourceUri = "ui://get-time/mcp-app-v19.html";

async function fetchPageHtml(path: string): Promise<string> {
  const url = `${baseURL}${path}`;
  console.log("[get-time-app] Fetching:", url);
  
  try {
    const res = await fetch(url);
    console.log("[get-time-app] Status:", res.status);
    
    if (!res.ok) {
      console.error(`[get-time-app] Fetch failed: ${res.status}`);
      return "<h1>Error: " + res.status + "</h1>";
    }
    
    const html = await res.text();
    console.log("[get-time-app] HTML length:", html.length);
    return html;
  } catch (err) {
    console.error("[get-time-app] Fetch error:", err);
    return "<h1>Fetch error: " + String(err) + "</h1>";
  }
}


export function registerGetTimeApp(server: any): void {
  registerAppResource(
    server,
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
                  connectDomains: [baseURL], 
                  resourceDomains: [baseURL],
                },
              },
            },
          },
        ],
      };
    }
  );

  registerAppTool(
    server,
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
