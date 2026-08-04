# MCP server

[app/mcp/route.ts](../../app/mcp/route.ts) exports one `mcp-handler` handler as GET/POST/DELETE, re-wrapping the response to strip Content-Security-Policy headers (they break MCP App iframes). Tools register through the single entry point `registerAllTools` in [app/mcp/tools/index.ts](../../app/mcp/tools/index.ts) — add new tools there.

Tool schemas import `zod/v4` (`import * as z from "zod/v4"`), while the MCP Apps helpers use plain `zod`. Match whichever the neighbouring file uses.

Both search tools return a text rendering *and* `structuredContent`, and both catch errors into `{ isError: true }` rather than throwing. The text rendering is what the model actually cites, so it carries numbered citation headers built by [lib/citations.ts](../../lib/citations.ts) plus a deduplicated source list with blob URLs. `search_docs` is for direct lookups; `search_graph` is for relational questions — the descriptions say so explicitly and steer each other.

MCP prompts (user-triggered templates, distinct from model-invoked tools) mirror the tool pattern: each file under [app/mcp/prompts/](../../app/mcp/prompts/) exports a single `registerXPrompt(server)`, wired through `registerAllPrompts` in [app/mcp/prompts/index.ts](../../app/mcp/prompts/index.ts), called alongside `registerAllTools` in `route.ts`. In a client that surfaces MCP prompts as slash commands (e.g. Claude Code), they appear as `/mcp__<server>__<prompt-name>` — subject to the same session-start caching caveat as tools above.

MCP resources follow the same shape again: each file under [app/mcp/resources/](../../app/mcp/resources/) exports a single `registerXResource(server)`, wired through `registerAllResources` in [app/mcp/resources/index.ts](../../app/mcp/resources/index.ts), called alongside the tools and prompts registration in `route.ts`.

## MCP Apps (interactive UI)

`get_time_app` pairs a tool with an HTML resource: the resource handler server-side `fetch`es a rendered Next.js page (`/test`) and returns its HTML with a CSP allowlist. This is why [baseUrl.ts](../../baseUrl.ts) exists and why it is also set as Next's `assetPrefix` — the iframe loads assets from an absolute origin. `BASE_URL` overrides it; otherwise it derives from `VERCEL_*` env vars. Bump the version in `resourceUri` when changing the UI, since hosts cache resources by URI.

Client-side, [app/hooks/use-mcp-app.ts](../../app/hooks/use-mcp-app.ts) holds a module-level singleton `App` instance (one host bridge per iframe) with tool input/result mirrored into `sessionStorage` so state survives navigation and HMR.

## MCP Apps skills

[.claude/skills/](../skills/) vendors four skills from `modelcontextprotocol/ext-apps`, with upstream provenance pinned by hash in `skills-lock.json`: `/add-app-to-server`, `/create-mcp-app`, `/convert-web-app`, `/migrate-oai-app`. Read the relevant one before adding or changing MCP App UI code.

These were originally installed to `.agents/skills/`, which Claude Code does not read. If a skills installer re-runs against `skills-lock.json` and recreates `.agents/skills/`, move the result back under `.claude/skills/` rather than keeping both.

See also: [mcp-tools rule](../rules/mcp-tools.md) — the path-scoped detail (registration mechanics, citation rendering) that auto-loads when you're actually editing `app/mcp/**`.
