import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "./tools";
import { registerAllPrompts } from "./prompts";
import { registerAllResources } from "./resources";
import { registerAllApps } from "./apps";

// ---------------------------------------------------------------------------
// Why this function runs in Sydney
// ---------------------------------------------------------------------------
// `submit_schedule` fetches an AER workbook from inside this deployment, and
// **aer.gov.au refuses US-region traffic**. Measured, not guessed: from an
// `iad1` sandbox, curl exits 92 (Akamai killing the HTTP/2 stream) in 0.1s on
// both IPv4 and IPv6 and `fetch` reports `read ETIMEDOUT`; from `syd1` the same
// URL returns 200 with the whole 1,040,321-byte workbook. The project's default
// region is `iad1`, so the first authorised ingest burned the function's full
// 300-second budget and reported `fetch failed`.
//
// Pinned here rather than project-wide, and here rather than in a separate
// fetch route, because the alternatives are worse: moving every function
// changes latency for paths that have no reason to move, and a second public
// route that fetches a supplied URL would widen the one surface this server is
// careful about (see request-document.ts).
//
// The cost is that the search tools also run from Sydney now, which is a wash
// at worst: they were already paying a Pacific crossing on the client leg for
// an Australian caller, and this moves it to the datastore leg instead.
//
// What this does *not* fix: `backfillSchedules` fetches inside a `"use step"`
// function, and those compile into generated routes under
// `app/.well-known/workflow/` that must not be hand-edited — so bulk discovery
// still runs wherever the project default puts it. One workbook at a time works;
// the backfill needs a project-level region change or a different approach.
export const preferredRegion = "syd1";

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


