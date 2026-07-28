---
paths:
  - "app/mcp/**/*.ts"
  - "app/hooks/use-mcp-app.ts"
---

# MCP server conventions

## Registration

Every tool is registered through `registerAllTools` in [app/mcp/tools/index.ts](../../app/mcp/tools/index.ts). A new tool file exports a single `registerXTool(server)` function and is added there — that is the only wiring point.

Import `* as z from "zod/v4"` for `registerTool` input schemas. The `@modelcontextprotocol/ext-apps` helpers use plain `zod`. Match the file you're editing rather than unifying them.

## Tool results

- Return both a `content` text block and `structuredContent`.
- Catch errors into `{ isError: true, content: [...] }` with the real message. Never let a tool throw, and never return a bare success count with no payload.
- Handle the empty case explicitly with a message that says what the index covers and suggests the sibling tool.

## The text block is what gets cited

Models cite what they can read, so the text rendering — not `structuredContent` — carries the citation scaffolding. Build it with `toCitation` and `citationLine` from [lib/citations.ts](../../lib/citations.ts): numbered `[n]` headers, results joined by `---`, then a `Sources:` list deduplicated by `citation.source` so each document's URL appears at most once. When no URL is indexed, print `no URL in index` rather than omitting the line.

Tool descriptions must tell the model when *not* to use the tool and point at the alternative — `search_docs` for direct lookups within a topic, `search_graph` for relational questions. They steer each other; update both sides together.

## Query embeddings

`google/gemini-embedding-2`, `outputDimensionality: 1536`, `taskType: "RETRIEVAL_QUERY"`, prefixed `task: search result | query: …`. This mirrors the document side in `app/api/upload/steps/`; changing one without the other silently degrades retrieval.

## Cypher

Neo4j cannot parameterize variable-length path bounds, so `maxHops` is clamped in the schema *and* re-clamped with `Math.min/Math.max` before interpolation. Keep both. Everything else — embeddings, filters — goes through `$params`, never string interpolation.

Access the graph through `readGraph`/`writeGraph`/`withSession` from [lib/graph.ts](../../lib/graph.ts) so sessions are always closed. Never call `driver.session()` directly.

## Route handler

[app/mcp/route.ts](../../app/mcp/route.ts) deliberately re-wraps the `mcp-handler` response to strip `Content-Security-Policy` headers, which otherwise break MCP App iframes. Preserve that when touching the handler.

## MCP Apps

- Resource HTML is fetched server-side from a rendered Next.js page using the absolute `baseURL` from [baseUrl.ts](../../baseUrl.ts) — also Next's `assetPrefix`. Never build these URLs relative.
- Hosts cache resources by URI, so bump the version in `resourceUri` (`ui://get-time/mcp-app-vN.html`) whenever the UI changes.
- Declare `_meta.ui.csp.connectDomains`/`resourceDomains` for any origin the UI contacts.
- Link tool to resource via `_meta.ui.resourceUri`. The tool must still return a useful text result for text-only clients — UI is an enhancement, not a replacement.
- Client side, consume the bridge only through `useMcpApp` in [app/hooks/use-mcp-app.ts](../../app/hooks/use-mcp-app.ts). The `App` instance is a module-level singleton (one host bridge per iframe) with state mirrored to `sessionStorage`; do not construct a second `App`.

Before adding or restructuring MCP App UI, invoke the matching vendored skill: `/create-mcp-app`, `/add-app-to-server`, `/convert-web-app`, or `/migrate-oai-app` (see [.claude/skills/](../skills/)).
