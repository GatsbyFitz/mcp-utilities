# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install          # ignore-scripts=true is set in .npmrc; native builds are allowlisted in pnpm-workspace.yaml
pnpm dev              # Next.js dev server on http://localhost:3000
pnpm build
pnpm type-check       # tsc --noEmit
pnpm lint             # eslint (next/core-web-vitals; no-explicit-any is disabled)
```

There is no test framework in this repo. `pnpm type-check` and `pnpm lint` are the only automated verification available — run both after changes.

## Path-scoped rules

Detailed conventions live in [.claude/rules/](.claude/rules/) and load only when editing matching files. This file covers what the system *is*; the rules cover what to *do* when editing a given area.

| Rule | Scope |
| --- | --- |
| [api-routes.md](.claude/rules/api-routes.md) | `app/api/**/*.ts` — route handler shape, error/response conventions |
| [workflow-steps.md](.claude/rules/workflow-steps.md) | `app/api/upload/workflow.ts`, `app/api/upload/steps/**` — durability, retry semantics, extraction limits |
| [mcp-tools.md](.claude/rules/mcp-tools.md) | `app/mcp/**/*.ts`, `app/hooks/use-mcp-app.ts` — tool registration, citation rendering, MCP Apps |

## Architecture

A Next.js 15 App Router app with two halves that share one storage layer:

1. **Ingestion** — a durable workflow that turns an uploaded PDF into a vector index *and* a knowledge graph.
2. **Serving** — an MCP server at `/mcp` exposing search tools over that data.

### Ingestion pipeline

`POST /api/upload` starts one `ingestPdf` workflow per file via `start()` from `workflow/api`. The workflow ([app/api/upload/workflow.ts](app/api/upload/workflow.ts)) is marked `"use workflow"`; every function in [app/api/upload/steps/](app/api/upload/steps/) is marked `"use step"`. `withWorkflow()` wraps the Next config, which compiles those directives into the generated routes under `app/.well-known/workflow/v1/` — those files (and `manifest.json`) are build artifacts, entirely gitignored. Never hand-edit them.

Step order: `uploadPdf` (Vercel Blob) → `createMarkdown` (Gemini PDF→Markdown) → `createEmbeddings` (Upstash Vector) → `extractGraph` (Neo4j) → `recordUpload` (Neon Postgres `uploads` table).

Retry semantics come from the error type: throw `FatalError` from `workflow` to abort the workflow, a plain `Error` to make the step retryable. `pdfReader.ts` uses both deliberately.

`extractGraph` is a separate step from `createEmbeddings` on purpose — extraction is the expensive, flaky part, and retrying it must not re-embed the document. It therefore re-derives chunks from the markdown rather than receiving them.

### The chunking invariant

[lib/chunking.ts](lib/chunking.ts) is the single source of truth for chunk boundaries and IDs. `createEmbeddings` and `extractGraph` both call it independently, and `search_graph` stores a `chunkId` on each Neo4j relationship that it later feeds straight to `vectorIndex.fetch()`. If those two steps ever disagree on chunking, every graph hit returns a wrong or missing excerpt. Change `chunkText`/`chunkId` only with a full re-ingest in mind.

### Embeddings

Always `google/gemini-embedding-2` at `outputDimensionality: 1536`, matching the Upstash index and the Neo4j `entity_names` vector index. The convention is asymmetric: documents embed with `taskType: "RETRIEVAL_DOCUMENT"` and prefix `title: … | text: …`; queries embed with `taskType: "RETRIEVAL_QUERY"` and prefix `task: search result | query: …`. Keep both sides in sync.

### Graph shape

`extractGraph` writes exactly what `search_graph` reads: `(:Entity {name, type, embedding})` joined by `[:RELATES {type, description, chunkId, sourceDoc}]`. Writes are idempotent per document — `replaceDocumentGraph` deletes that document's edges, MERGEs entities (shared across documents), recreates edges, then prunes orphaned entities. Entities with no edges are never persisted, since `search_graph`'s `MATCH` can't reach them.

Cypher can't parameterize variable-length bounds, so `maxHops` is schema-clamped to 1–2 and interpolated into the query string. Keep it clamped.

### MCP server

[app/mcp/route.ts](app/mcp/route.ts) exports one `mcp-handler` handler as GET/POST/DELETE, re-wrapping the response to strip Content-Security-Policy headers (they break MCP App iframes). Tools register through the single entry point `registerAllTools` in [app/mcp/tools/index.ts](app/mcp/tools/index.ts) — add new tools there.

Tool schemas import `zod/v4` (`import * as z from "zod/v4"`), while the MCP Apps helpers use plain `zod`. Match whichever the neighbouring file uses.

Both search tools return a text rendering *and* `structuredContent`, and both catch errors into `{ isError: true }` rather than throwing. The text rendering is what the model actually cites, so it carries numbered citation headers built by [lib/citations.ts](lib/citations.ts) plus a deduplicated source list with blob URLs. `search_docs` is for direct lookups; `search_graph` is for relational questions — the descriptions say so explicitly and steer each other.

### MCP Apps (interactive UI)

`get_time_app` pairs a tool with an HTML resource: the resource handler server-side `fetch`es a rendered Next.js page (`/test`) and returns its HTML with a CSP allowlist. This is why [baseUrl.ts](baseUrl.ts) exists and why it is also set as Next's `assetPrefix` — the iframe loads assets from an absolute origin. `BASE_URL` overrides it; otherwise it derives from `VERCEL_*` env vars. Bump the version in `resourceUri` when changing the UI, since hosts cache resources by URI.

Client-side, [app/hooks/use-mcp-app.ts](app/hooks/use-mcp-app.ts) holds a module-level singleton `App` instance (one host bridge per iframe) with tool input/result mirrored into `sessionStorage` so state survives navigation and HMR.

### Data stores

| Store | Accessor | Notes |
| --- | --- | --- |
| Upstash Vector | `vectorIndex` in [lib/vector.ts](lib/vector.ts) | chunk text + citation metadata |
| Neo4j Aura | `readGraph`/`writeGraph`/`withSession` in [lib/graph.ts](lib/graph.ts) | driver is a lazily-built `globalThis` singleton, built on first query rather than at import so a config error doesn't take down every workflow step in the route |
| Neon Postgres | `sql` in [lib/db.ts](lib/db.ts) | `uploads` table, read back by `GET /api/returnKnowledgeBase` |

Neither the `uploads` table nor the Neo4j `entity_names` vector index is created by code in this repo — they must already exist in the provisioned services. Required env vars live in `.env.local` (gitignored): `UPSTASH_VECTOR_REST_URL`/`_TOKEN`, `NEO4J_URI`/`_USERNAME`/`_PASSWORD`/`_DATABASE`, `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `AI_GATEWAY_API_KEY`.

### CORS

[middleware.ts](middleware.ts) applies permissive CORS to everything and short-circuits `OPTIONS`. Its matcher deliberately excludes `/.well-known/workflow/` so the workflow runtime's internal routes are untouched.

## MCP Apps skills

[.claude/skills/](.claude/skills/) vendors four skills from `modelcontextprotocol/ext-apps`, with upstream provenance pinned by hash in `skills-lock.json`: `/add-app-to-server`, `/create-mcp-app`, `/convert-web-app`, `/migrate-oai-app`. Read the relevant one before adding or changing MCP App UI code.

These were originally installed to `.agents/skills/`, which Claude Code does not read. If a skills installer re-runs against `skills-lock.json` and recreates `.agents/skills/`, move the result back under `.claude/skills/` rather than keeping both.
