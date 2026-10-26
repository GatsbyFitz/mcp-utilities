import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "./tools";
import { registerAllPrompts } from "./prompts";
import { registerAllResources } from "./resources";
import { registerAllApps } from "./apps";

// ---------------------------------------------------------------------------
// This function has to run in Australia, and that is a project setting
// ---------------------------------------------------------------------------
// `submit_schedule` fetches an AER workbook from inside this deployment, and
// **aer.gov.au refuses US-region traffic**. Measured from Vercel sandboxes in
// two regions, same URL, same request: from `iad1`, curl exits 92 in 0.1s on
// both IPv4 and IPv6 — Akamai accepting the connection and killing the HTTP/2
// stream — and `fetch` reports `read ETIMEDOUT`; from `syd1`, 200 with the
// whole 1,040,321-byte workbook.
//
// The obvious fix was `export const preferredRegion = "syd1"` here. It does
// nothing: that option steers Edge functions, and a Node serverless function
// takes its region from the *project* on every plan below Enterprise. It was
// tried, deployed, and the response still came back
// `x-vercel-id: iad1::iad1::…` — the second field is the function region. The
// lesson is worth more than the line, so the line is gone and this is here.
//
// The lever is the project's `serverlessFunctionRegion`, now `syd1`. It is not
// visible from the code, which this repo generally dislikes (see
// `anthropicByok`), and this comment is the compensation: if AER fetches start
// timing out, check that setting first.
const baseHandler = createMcpHandler((server) => {
  registerAllTools(server);
  registerAllPrompts(server);
  registerAllResources(server);
  registerAllApps(server);
});

async function handler(req: Request) {
  const response = await baseHandler(req);
  
  // Clone the response instead of converting to text
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
  });
  
  // Copy headers except CSP
  for (const [key, value] of response.headers) {
    const lowerKey = key.toLowerCase();
    if (!lowerKey.includes("content-security-policy")) {
      newResponse.headers.set(key, value);
    }
  }
  
  return newResponse;
}

export { handler as GET, handler as POST, handler as DELETE };


