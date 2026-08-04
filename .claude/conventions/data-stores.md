# Data stores

A Next.js 15 App Router app with two halves that share this one storage layer:

1. **Ingestion** — a durable workflow that turns an uploaded PDF into a vector index *and* a knowledge graph. See [ingestion-pipeline.md](ingestion-pipeline.md).
2. **Serving** — an MCP server at `/mcp` exposing search tools over that data. See [mcp-server.md](mcp-server.md).

| Store | Accessor | Notes |
| --- | --- | --- |
| Upstash Vector | `vectorIndex` in [lib/vector.ts](../../lib/vector.ts) | chunk text + citation metadata |
| Neo4j Aura | `readGraph`/`writeGraph`/`withSession` in [lib/graph.ts](../../lib/graph.ts) | driver is a lazily-built `globalThis` singleton, built on first query rather than at import so a config error doesn't take down every workflow step in the route |
| Neon Postgres | `sql` in [lib/db.ts](../../lib/db.ts) | `uploads` table, read back by `GET /api/returnKnowledgeBase` |

Neither the `uploads` table nor the Neo4j `entity_names` vector index is created by code in this repo — they must already exist in the provisioned services. Required env vars live in `.env.local` (gitignored): `UPSTASH_VECTOR_REST_URL`/`_TOKEN`, `NEO4J_URI`/`_USERNAME`/`_PASSWORD`/`_DATABASE`, `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `AI_GATEWAY_API_KEY`.

## CORS

[middleware.ts](../../middleware.ts) applies permissive CORS to everything and short-circuits `OPTIONS`. Its matcher deliberately excludes `/.well-known/workflow/` so the workflow runtime's internal routes are untouched.
