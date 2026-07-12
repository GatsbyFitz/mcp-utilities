import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

function buildLogoSvg(label: string, hue: number): string {
  const safe = label.replace(/[<>&"]/g, "");
  const h = Math.max(0, Math.min(360, Math.round(hue)));
  return [
    "<svg xmlns='http://www.w3.org/2000/svg' width='640' height='220' viewBox='0 0 640 220'>",
    "<defs>",
    "<linearGradient id='g' x1='0%' y1='0%' x2='100%' y2='100%'>",
    "<stop offset='0%' stop-color='hsl(" + h + ",90%,58%)'/>",
    "<stop offset='100%' stop-color='hsl(" + ((h + 70) % 360) + ",85%,52%)'/>",
    "</linearGradient>",
    "</defs>",
    "<rect width='640' height='220' rx='26' fill='#0b1020'/>",
    "<circle cx='108' cy='110' r='62' fill='url(#g)'/>",
    "<circle cx='108' cy='110' r='30' fill='#0b1020'/>",
    "<rect x='180' y='78' width='16' height='64' rx='8' fill='url(#g)'/>",
    "<text x='212' y='121' fill='white' font-size='42' font-family='system-ui, sans-serif' font-weight='700'>",
    safe,
    "</text>",
    "<text x='212' y='156' fill='rgba(255,255,255,0.72)' font-size='20' font-family='system-ui, sans-serif'>",
    "Dynamic Utilities Logo",
    "</text>",
    "</svg>",
  ].join("");
}

export function registerLogoTool(server: McpServer): void {
  server.registerTool(
    "show_utilities_logo",
    {
      title: "show_utilities_logo",
      description: "Render a dynamic Utilities logo as SVG.",
      inputSchema: z.object({
        label: z.string().min(2).max(40).default("Utilities"),
        hue: z.number().min(0).max(360).default(210),
      }),
    },
    async ({ label, hue }) => {
      const svg = buildLogoSvg(label, hue);
      const data = Buffer.from(svg, "utf8").toString("base64");

      return {
        content: [
          { type: "text", text: "Rendered logo for " + label + "." },
          { type: "image", mimeType: "image/svg+xml", data },
        ],
        structuredContent: {
          label,
          hue,
        },
      };
    }
  );
}