import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const logoAppUri = "ui://utilities/logo-app-v2.html"
const resourceMimeType = "text/html;profile=mcp-app";
const resourceUriMetaKey = "ui/resourceUri";

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
    "Interactive Utilities Logo",
    "</text>",
    "</svg>",
  ].join("");
}

const logoAppHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Utilities Logo App</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: #0b1020;
      color: #fff;
      padding: 16px;
    }
    .card {
      max-width: 760px;
      margin: 0 auto;
      background: #121a32;
      border: 1px solid #2b355c;
      border-radius: 14px;
      padding: 16px;
    }
    .row { display: grid; gap: 8px; margin-bottom: 12px; }
    label { font-size: 13px; opacity: 0.85; }
    input[type="text"], input[type="range"] { width: 100%; }
    .logo-wrap {
      margin-top: 12px;
      background: #0b1020;
      border: 1px solid #2b355c;
      border-radius: 12px;
      padding: 8px;
      overflow: auto;
    }
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin:0 0 10px 0;">Utilities Logo</h2>
    <div class="row">
      <label>Label</label>
      <input id="label" type="text" value="Utilities" maxlength="40" />
    </div>
    <div class="row">
      <label>Hue: <span id="hueVal">210</span></label>
      <input id="hue" type="range" min="0" max="360" value="210" />
    </div>
    <div class="logo-wrap" id="logoMount"></div>
  </div>

  <script>
    function esc(s) {
      return String(s).replace(/[<>&"]/g, "");
    }

    function svg(label, hue) {
      const h = Math.max(0, Math.min(360, Math.round(Number(hue))));
      const h2 = (h + 70) % 360;
      return [
        "<svg xmlns='http://www.w3.org/2000/svg' width='640' height='220' viewBox='0 0 640 220'>",
        "<defs>",
        "<linearGradient id='g' x1='0%' y1='0%' x2='100%' y2='100%'>",
        "<stop offset='0%' stop-color='hsl(" + h + ",90%,58%)'/>",
        "<stop offset='100%' stop-color='hsl(" + h2 + ",85%,52%)'/>",
        "</linearGradient>",
        "</defs>",
        "<rect width='640' height='220' rx='26' fill='#0b1020'/>",
        "<circle cx='108' cy='110' r='62' fill='url(#g)'/>",
        "<circle cx='108' cy='110' r='30' fill='#0b1020'/>",
        "<rect x='180' y='78' width='16' height='64' rx='8' fill='url(#g)'/>",
        "<text x='212' y='121' fill='white' font-size='42' font-family='system-ui, sans-serif' font-weight='700'>",
        esc(label),
        "</text>",
        "<text x='212' y='156' fill='rgba(255,255,255,0.72)' font-size='20' font-family='system-ui, sans-serif'>",
        "Interactive Utilities Logo",
        "</text>",
        "</svg>"
      ].join("");
    }

    const labelEl = document.getElementById("label");
    const hueEl = document.getElementById("hue");
    const hueValEl = document.getElementById("hueVal");
    const logoMount = document.getElementById("logoMount");

    function render() {
      hueValEl.textContent = hueEl.value;
      logoMount.innerHTML = svg(labelEl.value || "Utilities", hueEl.value);
    }

    labelEl.addEventListener("input", render);
    hueEl.addEventListener("input", render);
    render();
  </script>
</body>
</html>`;

export function registerUtilitiesLogoApp(server: McpServer): void {
  server.registerResource(
    "utilities-logo-app",
    logoAppUri,
    {
      title: "Utilities Logo App",
      description: "Interactive logo app UI",
      mimeType: resourceMimeType,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: resourceMimeType,
          text: logoAppHtml,
        },
      ],
    })
  );

  server.registerTool(
    "open_utilities_logo_app",
    {
      title: "Open Utilities Logo App",
      description: "Open an interactive Utilities logo app.",
      inputSchema: z.object({
        label: z.string().min(2).max(40).default("Utilities"),
        hue: z.number().min(0).max(360).default(210),
      }),
      _meta: {
        ui: {
          resourceUri: logoAppUri,
        },
        [resourceUriMetaKey]: logoAppUri,
      },
    },
    async ({ label, hue }) => ({
      content: [{ type: "text", text: "Opened interactive logo app." }],
      structuredContent: { label, hue, svg: buildLogoSvg(label, hue) },
    })
  );
}