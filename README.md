# mcp-utilities

A Next.js 15 app that ingests PDFs into a vector index and a knowledge graph, then serves both over an MCP server at `/mcp` so an LLM client (e.g. Claude Code) can search them with citations.

## Architecture summary

The app is one Next.js 15 deployment split into two halves that never call each other directly — they only agree on shared storage and a shared chunking function:

```
PDF upload                                    MCP client (e.g. Claude Code)
    │                                                      │
    ▼                                                      ▼
POST /api/upload                                      GET/POST /mcp
    │  (durable workflow, one per file)                    │  (mcp-handler)
    │                                              ┌────────┴────────┐
    ▼                                              ▼                 ▼
1. uploadPdf        → Vercel Blob             search_docs        search_graph
2. createMarkdown    (Gemini PDF→MD)          (vector + sparse    (graph walk +
3. createEmbeddings → Upstash Vector           hybrid + rerank)    vector-seeded)
4. extractGraph     → Neo4j Aura                    │                 │
5. recordUpload     → Neon Postgres                 ▼                 ▼
                                                Upstash Vector      Neo4j Aura
                                                                  + Upstash Vector
                                                                    (excerpt fetch)
```

- **Ingestion** (`app/api/upload/workflow.ts`, marked `"use workflow"`) is durable — each step is a separately retryable unit, compiled by `withWorkflow()` into generated routes under `app/.well-known/workflow/v1/` (gitignored build artifacts, never hand-edited).
- **Serving** (`app/mcp/route.ts`) is a stateless MCP handler that only reads from the stores ingestion wrote to. It never touches the workflow.
- The two halves are coupled by exactly one invariant: `lib/chunking.ts` must produce identical chunk boundaries/IDs for both `createEmbeddings` and `extractGraph`, because `search_graph` takes a `chunkId` off a Neo4j relationship and fetches that exact chunk straight out of Upstash Vector. Disagreement here silently breaks graph-result citations.

| Store | Written by | Read by | Purpose |
| --- | --- | --- | --- |
| Vercel Blob | `uploadPdf` | `kb://documents` resource (URL only) | original PDF bytes |
| Upstash Vector | `createEmbeddings` | `search_docs`, `search_graph` | chunk text + citation metadata, semantic/hybrid search |
| Neo4j Aura | `extractGraph` | `search_graph` | entities + relationships extracted from chunks |
| Neon Postgres | `recordUpload` | `kb://documents` resource | one row per ingested document (name, chunk count, size, blob URL) |

See [.claude/conventions/](.claude/conventions/) for the full architecture writeup (this section is a summary of it).

## Ingestion pipeline

`POST /api/upload` starts one workflow per file, with these steps in order:

1. **uploadPdf** — stores the file in Vercel Blob
2. **createMarkdown** — converts the PDF to Markdown via Gemini
3. **createEmbeddings** — chunks the markdown (`lib/chunking.ts`) and embeds each chunk into Upstash Vector (`google/gemini-embedding-2`, 1536 dimensions)
4. **extractGraph** — re-derives the same chunks and extracts entities/relationships into Neo4j
5. **recordUpload** — writes a row to the Neon `uploads` table

`createEmbeddings` and `extractGraph` chunk independently but must agree on chunk boundaries and IDs (`lib/chunking.ts` is the single source of truth) — `search_graph` uses a chunk's `chunkId` to fetch its text straight out of the vector index.

### Progress tracking

`POST /api/upload` returns a `runs` array pairing each file name with its workflow run ID. `GET /api/uploadStatus?runId=…` (auth-gated, repeatable param) resolves those IDs live against the workflow runtime — `getRun()` for the run status and `getWorld().steps.list()` for per-step status and retry attempt — and folds them against the ordered step list in [lib/ingestSteps.ts](lib/ingestSteps.ts). The upload page polls it every 2s and renders a per-file progress bar, refreshing the knowledge-base table only once the runs reach a terminal state (the rows do not exist until `recordUpload`, the final step).

Nothing about a run is persisted: status comes from the runtime on each request, so run IDs live only in the browser tab that started the upload (mirrored to `sessionStorage` for reload recovery). A run the runtime no longer knows about reports as `unknown`. Vercel's own dashboard (Project → Observability → Workflows) remains the deeper view for debugging.

## MCP server features

Everything below is registered in `app/mcp/tools/index.ts`, `app/mcp/prompts/index.ts`, and `app/mcp/resources/index.ts`, then wired together in `app/mcp/route.ts`.

### Tools

**`search_docs`** — Hybrid search over document chunks: semantic vector search (Gemini embeddings) combined with exact-term/sparse matching (for codes and IDs like `IN008-24`), then reranked with `cohere/rerank-v3.5`. Returns a numbered, citation-annotated text rendering plus `structuredContent`. Use for direct factual lookups within a topic.

**`search_graph`** — Searches the Neo4j knowledge graph for entities and relationships extracted from uploaded documents. Seeds from a vector similarity search over entity names, walks 1–2 hops of `[:RELATES]` edges, then pulls supporting document excerpts for the closest-hop relationships. Returns relationship paths (`[R1]`, `[R2]`, …) plus excerpts (`[1]`, `[2]`, …) with citations. Use for relational questions — obligations or dependencies between parties, how concepts connect, definitions spanning documents.

**`echo`** — Trivial diagnostic tool that echoes back a message. Useful for confirming the MCP connection is alive.

Both search tools:
- render numbered citation headers (document title, version, page range) via `lib/citations.ts`, plus a deduplicated source list with blob URLs
- catch errors into `{ isError: true }` rather than throwing
- share embedding conventions: queries embed with `taskType: "RETRIEVAL_QUERY"` and prefix `task: search result | query: …`, matching how documents were embedded (`RETRIEVAL_DOCUMENT`, `title: … | text: …`)

### RAG capabilities

The two search tools together implement two complementary retrieval strategies over the same underlying chunks:

- **Hybrid dense + sparse retrieval** (`search_docs`) — every query is embedded with `google/gemini-embedding-2` (1536-dim, `RETRIEVAL_QUERY` task type) *and* turned into a sparse vector (`lib/sparse.ts`) for exact-term matching, so a query like `"IN008-24"` still surfaces the right chunk even though semantic similarity alone would miss an opaque ID. Upstash Vector blends the two with `WeightingStrategy.IDF`. Candidates are then reranked with `cohere/rerank-v3.5` to fix ordering imprecision from the retrieval step before the top `topN` are returned. This is standard single-hop RAG: retrieve, rerank, cite.
- **Graph RAG** (`search_graph`) — instead of retrieving chunks directly, the query embedding first finds the closest *entities* (`entity_names` vector index in Neo4j), then walks 1–2 hops of `[:RELATES]` edges outward from those entities. This answers questions a chunk-similarity search structurally can't: multi-hop relationships, obligations between named parties, or facts that only emerge by connecting two documents that never appear in the same chunk. It only pulls chunk text back in as *supporting evidence* for the relationships it finds, via the shared `chunkId`.
- **Citations as a first-class concern, not a footnote** — both tools route through `lib/citations.ts` for a consistent numbered-header format (title, version, page range) and deduplicate source URLs so a model synthesizing an answer can cite precisely and cheaply, rather than re-deriving citation text per result.
- **Tool descriptions steer the calling model**, not just document it — `search_docs` and `search_graph`'s registered descriptions explicitly tell the model when to prefer the other tool, and the `research-topic` prompt hard-codes a "call both, then reconcile disagreement" workflow rather than leaving retrieval strategy to the model's judgment alone.

### Prompts

**`research-topic`** — A user-triggered template (`/mcp__<server>__research-topic` in Claude Code) that instructs the model to call `search_docs` then `search_graph` for a given topic and synthesize both result sets into one cited answer, flagging disagreement between the two rather than papering over it.

### Resources

**`kb://documents`** — Lists every document currently indexed, read straight from the Neon `uploads` table (id, name, chunk count, size, upload time, blob URL). Reflects the ingestion pipeline's final step.

### MCP Apps (interactive UI)

The server has infrastructure for MCP Apps (tools paired with an interactive HTML UI resource rendered inside the client) via `app/mcp/apps/get-time-app.ts`, but `registerGetTimeApp` is **not currently wired into `registerAllTools`** — it exists as a reference implementation, not an active feature.

## Local development

```bash
pnpm install
pnpm dev              # Next.js dev server on http://localhost:3000
```

With `pnpm dev` running, `.mcp.json` registers an HTTP MCP connection (`mcp-utilities-local`) to `http://localhost:3000/mcp`, exposing the real tools prefixed `mcp-utilities-local__` for local testing. A separate `claude.ai MCP` connection points at the deployed instance and reflects whatever is currently shipped, not local edits.

```bash
pnpm build
pnpm type-check       # tsc --noEmit
pnpm lint             # eslint
```

There is no test framework in this repo — `pnpm type-check` and `pnpm lint` are the only automated checks.

## Environment variables

Required in `.env.local` (gitignored): `UPSTASH_VECTOR_REST_URL`/`_TOKEN`, `NEO4J_URI`/`_USERNAME`/`_PASSWORD`/`_DATABASE`, `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `AI_GATEWAY_API_KEY`.

The Neon `uploads` table and the Neo4j `entity_names` vector index must already exist in the provisioned services — nothing in this repo creates them.
