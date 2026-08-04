# Reference: MCP JSON-RPC over HTTP

Deeper detail for `SKILL.md`'s steps — protocol mechanics, full request/response shapes for every tool/prompt/resource currently registered, and the SSE wrinkle. Read this when a step in `SKILL.md` fails and you need to know *why*, not just *what to run*.

## Transport shape

`mcp-handler` speaks the [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http). Two things trip people up:

- **`Accept` must list both** `application/json` and `text/event-stream`. Send only `application/json` and some servers 406; send only `text/event-stream` and you get a raw SSE stream back instead of a single JSON body, which breaks naive `curl | jq`.
- **The response may itself be SSE**, even for a single request — one `data: {...}` line containing the JSON-RPC response. If a response body starts with `event:`/`data:` instead of `{`, strip the `data: ` prefix before parsing:
  ```bash
  curl -sS ... | sed -n 's/^data: //p'
  ```
- **Session affinity.** `initialize` returns an `mcp-session-id` response header. Every call after that must echo it back as a request header or the server treats you as a fresh, uninitialized client and 400s. `DELETE /mcp` with that header ends the session — not required for a one-off verification, but tidy if scripting a loop of runs.

## Full registered surface (as of this file's writing)

Cross-check `tools/list`/`prompts/list`/`resources/list` output against this table. If you added/removed something, this table is stale — update it as part of that change, same as any other doc drift.

### Tools (`app/mcp/tools/`)

| name | inputSchema | notes |
|---|---|---|
| `echo` | `{ message: string (1-100) }` | trivial connectivity check |
| `search_docs` | `{ query: string (2-1000), topK?: int 1-100 = 25, topN?: int 1-50 = 8 }` | hybrid vector+sparse search over Upstash, reranked |
| `search_graph` | `{ query: string (2-1000), maxHops?: int 1-2 = 2, maxChunks?: int 1-8 = 5 }` | Neo4j traversal + supporting chunk excerpts |

Full call bodies:

```bash
curl -sS http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"echo","arguments":{"message":"ping"}}}'

curl -sS http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"metering obligations","topK":10,"topN":3}}}'

curl -sS http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"search_graph","arguments":{"query":"metering obligations","maxHops":2,"maxChunks":3}}}'
```

A healthy `tools/call` response has `result.content` (a text block array) and usually `result.structuredContent`, with no `result.isError`. `echo` is the fastest sanity check — no external services touched, so if it fails, the problem is registration/transport, not Upstash/Neo4j credentials.

### Prompts (`app/mcp/prompts/`)

| name | argsSchema |
|---|---|
| `research-topic` | `{ topic: string (2-500) }` |

```bash
curl -sS http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":13,"method":"prompts/get","params":{"name":"research-topic","arguments":{"topic":"metering obligations"}}}'
```

A healthy response has `result.messages`, an array of `{ role, content: { type: "text", text } }`. If `text` contains raw zod method names (`toJSONSchema`, `safeParse`, ...) instead of your prompt text, that's the `argsSchema` corruption bug described in `mcp-server.md` — check the installed `mcp-handler`/`@modelcontextprotocol/server` versions before touching the prompt file itself.

### Resources (`app/mcp/resources/`)

| uri | mimeType |
|---|---|
| `kb://documents` | `application/json` |

```bash
curl -sS http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":14,"method":"resources/read","params":{"uri":"kb://documents"}}'
```

A healthy response has `result.contents[0].text` as a JSON string; parse it (`| jq -r '.result.contents[0].text' | jq .`) to check the `documents` array shape rather than eyeballing the escaped string.

### MCP Apps resources (`app/mcp/apps/`)

`get_time_app` exists in the codebase but, as of this writing, is **not** wired into `registerAllTools` (confirm with `tools/list` — if it's absent, that's expected, not a bug to fix unless you're the one who's supposed to re-enable it).

## One-shot script

For a full pass without re-typing session plumbing each time:

```bash
BASE=http://localhost:3000/mcp
SESSION_ID=$(curl -sS -D - -o /dev/null "$BASE" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify-skill","version":"0.0.0"}}}' \
  | grep -i '^mcp-session-id:' | cut -d' ' -f2 | tr -d '\r')

call() { curl -sS "$BASE" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SESSION_ID" -d "$1"; echo; }

call '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
call '{"jsonrpc":"2.0","id":3,"method":"prompts/list"}'
call '{"jsonrpc":"2.0","id":4,"method":"resources/list"}'
call '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"echo","arguments":{"message":"ping"}}}'
```

## Why curl instead of the `mcp-utilities-local__*` tools

Covered briefly in `SKILL.md`; the full reason: Claude Code snapshots each MCP server's tool/prompt/resource list once, at session start. Editing `app/mcp/**` mid-session and then calling `mcp-utilities-local__search_docs` still hits the *old* schema/handler as far as Claude Code's own dispatch is concerned — it hasn't re-read the list. Raw curl bypasses that cache entirely since it's a fresh JSON-RPC exchange every time, which is why it's the only reliable way to verify a change within the same session that made it.
