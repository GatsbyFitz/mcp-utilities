# Commands

```bash
pnpm install          # ignore-scripts=true is set in .npmrc; native builds are allowlisted in pnpm-workspace.yaml
pnpm dev              # Next.js dev server on http://localhost:3000
pnpm build
pnpm type-check       # tsc --noEmit
pnpm lint             # eslint (next/core-web-vitals; no-explicit-any is disabled)
```

There is no test framework in this repo. `pnpm type-check` and `pnpm lint` are the only automated verification available — run both after changes.

## Testing MCP tools locally

[.mcp.json](../../.mcp.json) registers `mcp-utilities-local`, an HTTP MCP connection to `http://localhost:3000/mcp`. With `pnpm dev` running, this exposes the real `search_docs`/`search_graph`/`get_time_app`/`echo` tools (prefixed `mcp-utilities-local__`) so tool changes can be exercised directly, without deploying first. Claude Code only reads MCP server tool lists at session start, so a session started before `pnpm dev` was up won't see them — start a new session once the dev server is running.

There is also a `claude.ai MCP` connection to the deployed instance (`https://mcp-utilities.vercel.app/mcp`, prefixed `mcp__claude_ai_MCP__`). That one reflects whatever is currently deployed, not local edits — use the `mcp-utilities-local__` tools to verify changes before they ship.
