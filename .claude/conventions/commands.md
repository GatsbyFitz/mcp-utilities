# Commands

```bash
pnpm install          # ignore-scripts=true is set in .npmrc; native builds are allowlisted in pnpm-workspace.yaml
pnpm dev              # Next.js dev server on http://localhost:3000
pnpm build
pnpm type-check       # tsc --noEmit
pnpm lint             # eslint (next/core-web-vitals; no-explicit-any is disabled)
pnpm verify:multimodal # checks the figure embeddings actually carry their image
pnpm verify:context-caching # checks the contextualization prefix is actually cached
pnpm verify:ingest-secret # checks the submit_schedule credential fails closed
```

There is no test framework in this repo. `pnpm type-check` and `pnpm lint` are the only automated verification available — run both after changes.

Two checks need credentials and skip cleanly without them. `pnpm verify:aer-inference` is the second: it sends the real `inferMappings` prompt and a sheet captured from the live Schedule 2 Q4 2023-24 workbook to a model, then feeds the mapping that comes back to the shipped `extractRows` and reads five values against the spreadsheet cells they came from. `verify:aer` proves the extractor is right *given* a mapping; this is the only check on whether a model returns that mapping — which is where the collapse of five quarter columns into one key would come from. It reads `ANTHROPIC_API_KEY` from `.env.local` via `--env-file-if-exists`, so it runs with no argument and still skips cleanly where that file or key is absent. It calls Anthropic directly rather than through the gateway — one fewer moving part for a check about the prompt — but on `SHEET_MAPPING_MODEL` itself rather than a model id typed into the script, because a check against a model production does not use proves nothing about production. It refuses outright if that constant ever points somewhere it cannot call.

`pnpm verify:multimodal` is the one exception: a standalone check that figure embeddings really carry their image. Its first stage stubs `fetch` and asserts what the SDK *would* send, so it runs offline with no credentials and also guards the image-per-request batching in `embedFigures`; the second stage needs `AI_GATEWAY_API_KEY` and skips without it. It reads the key through `--env-file-if-exists`, not `--env-file`: with the latter it exited 9 on `node: .env.local: not found` in any checkout without that file, so the one check that was meant to run offline was the only one that could not run in a fresh clone. See [scripts/verify-multimodal-embedding.mjs](../../scripts/verify-multimodal-embedding.mjs).

`pnpm verify:context-caching` borrows that first stage wholesale, for the step where getting it wrong is expensive rather than wrong: it stubs `fetch`, runs the real `contextualizeChunks`, and asserts the cache breakpoint is on the document part and not the chunk part, that the document bytes are identical across calls, and that the step's own cache log reads the right fields off `usage`. Deliberately has no `--env-file`, so a real key in `.env.local` cannot make it behave differently from CI. It asserts the breakpoint reaches the *gateway*; whether the gateway relays it to Anthropic is the second hop, and the instrument for that is the step's per-document log on a real ingestion. See [scripts/verify-context-caching.mjs](../../scripts/verify-context-caching.mjs).

`pnpm verify:ingest-secret` is the other security-shaped one, and the reason it exists is that `submit_schedule` is the only tool on the public `/mcp` endpoint that will fetch a supplied URL and start a run. `MCP_INGEST_SECRET` is the whole difference between that and `request_document`, which stores a URL it will never fetch. The check asserts the three properties that design rests on — an unset variable refuses everything rather than allowing it, offering no secret queues rather than failing, and a *wrong* secret is refused outright rather than quietly downgraded to a queued request — plus that nothing throws where `timingSafeEqual` would on a length mismatch. It also covers the two Postgres conditions the tool has to recognise by message, the way `verify:sync-errors` does. Offline, and it sets the variable itself, so a real secret in `.env.local` cannot change what it asserts. See [scripts/verify-ingest-secret.mjs](../../scripts/verify-ingest-secret.mjs).

## Testing MCP tools locally

[.mcp.json](../../.mcp.json) registers `mcp-utilities-local`, an HTTP MCP connection to `http://localhost:3000/mcp`. With `pnpm dev` running, this exposes the real `search_docs`/`search_graph`/`get_time_app`/`echo` tools (prefixed `mcp-utilities-local__`) so tool changes can be exercised directly, without deploying first. Claude Code only reads MCP server tool lists at session start, so a session started before `pnpm dev` was up won't see them — start a new session once the dev server is running.

There is also a `claude.ai MCP` connection to the deployed instance (`https://mcp-utilities.vercel.app/mcp`, prefixed `mcp__claude_ai_MCP__`). That one reflects whatever is currently deployed, not local edits — use the `mcp-utilities-local__` tools to verify changes before they ship.
