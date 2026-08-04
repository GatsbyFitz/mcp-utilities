---
name: verify-mcp-server
description: This skill should be used when the user asks to "verify the MCP server", "test the MCP server", "check that MCP still works", or after any change to app/mcp/**/*.ts (tools, prompts, or resources) before considering the change done. Runs type-check, lint, and raw JSON-RPC calls against the local dev server to confirm tools/prompts/resources all still register and respond correctly.
---

# Verify MCP server

Confirms a change under `app/mcp/**` didn't break registration or runtime behavior, by exercising the server the same way a real MCP client would — raw JSON-RPC over HTTP against the local dev server — rather than trusting Claude Code's own tool surfacing, which only refreshes at session start (see [commands.md](../../conventions/commands.md)).

## Preconditions

- `pnpm dev` must be running on `http://localhost:3000`. Start it in the background if it isn't up; don't ask the user to do this manually.
- This targets the **local** server directly via curl, not the `mcp-utilities-local__*` tools — those require a session started after `pnpm dev` was already up, which usually isn't true mid-edit.

## Steps

1. **Static checks first** — cheap and catches most breakage before touching the network:
   ```bash
   pnpm type-check
   pnpm lint
   ```

2. **Initialize a session.** Every subsequent call needs the `mcp-session-id` response header from this call:
   ```bash
   curl -sS -D /tmp/mcp-headers.txt -o /tmp/mcp-init.json http://localhost:3000/mcp \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify-skill","version":"0.0.0"}}}'
   SESSION_ID=$(grep -i '^mcp-session-id:' /tmp/mcp-headers.txt | cut -d' ' -f2 | tr -d '\r')
   ```

3. **List each primitive** and confirm the file(s) you changed appear with the expected name/description/schema:
   ```bash
   curl -sS http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
   curl -sS http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" \
     -d '{"jsonrpc":"2.0","id":3,"method":"prompts/list"}'
   curl -sS http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" \
     -d '{"jsonrpc":"2.0","id":4,"method":"resources/list"}'
   ```

4. **Actually invoke** whatever you changed — a list response only proves registration, not that the handler runs:
   ```bash
   # tool
   curl -sS http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" \
     -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"test"}}}'

   # prompt
   curl -sS http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" \
     -d '{"jsonrpc":"2.0","id":6,"method":"prompts/get","params":{"name":"research-topic","arguments":{"topic":"test"}}}'

   # resource
   curl -sS http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" \
     -d '{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{"uri":"kb://documents"}}'
   ```
   Swap in the actual name/URI/arguments for whatever was added or edited.

5. **Read the response bodies**, don't just check the HTTP status — MCP errors come back as `200` with `{"isError": true, ...}` (tools) or a JSON-RPC `error` object (prompts/resources/protocol-level failures). A clean run has no `isError: true` and no top-level `error` key.

## Reference

[reference.md](reference.md) has the full JSON-RPC/SSE transport details, a table of every currently-registered tool/prompt/resource with its exact schema and a ready-to-run call for each, and a one-shot script covering the whole surface. Pull it up when a step here fails and you need to know why, or when verifying something not covered by the examples above.

## Interpreting failures

- `keyValidator._parse is not a function` / garbled argument names in a prompt's schema → an `argsSchema`/SDK version mismatch. See the `mcp-handler` version note in [mcp-server.md](../../conventions/mcp-server.md) before reverting to a raw-shape workaround.
- `tools/list`/`prompts/list`/`resources/list` missing an entry entirely → check it's wired into `registerAllTools`/`registerAllPrompts`/`registerAllResources` (each lives in its own `index.ts` under `app/mcp/*/`).
- Resource or tool handler throws instead of returning `isError`/an error content block → fix the handler; per [mcp-tools.md](../rules/mcp-tools.md) nothing under `app/mcp/**` should let an error escape uncaught.
