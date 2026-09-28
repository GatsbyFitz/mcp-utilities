# Data stores

A Next.js 15 App Router app with two halves that share this one storage layer:

1. **Ingestion** — a durable workflow that turns an uploaded PDF into a vector index *and* a knowledge graph. See [ingestion-pipeline.md](ingestion-pipeline.md).
2. **Serving** — an MCP server at `/mcp` exposing search tools over that data. See [mcp-server.md](mcp-server.md).

| Store | Accessor | Notes |
| --- | --- | --- |
| Upstash Vector | `vectorIndex` in [lib/vector.ts](../../lib/vector.ts) | chunk text + citation metadata |
| Neo4j Aura | `readGraph`/`writeGraph`/`withSession` in [lib/graph.ts](../../lib/graph.ts) | driver is a lazily-built `globalThis` singleton, built on first query rather than at import so a config error doesn't take down every workflow step in the route |
| Neon Postgres | `sql` in [lib/db.ts](../../lib/db.ts) | `uploads` (read back by `GET /api/returnKnowledgeBase`), `document_requests`, `ingestion_runs`, `compliance_actions` |
| Notion | `@notionhq/client` in [app/api/syncCompliance/route.ts](../../app/api/syncCompliance/route.ts) | source of the Compliance Tracker; read on demand, never at query time |

No table and no index is created by code in this repo — `uploads`, `document_requests` ([db/document_requests.sql](../../db/document_requests.sql)), `ingestion_runs` ([db/ingestion_runs.sql](../../db/ingestion_runs.sql)), `compliance_actions` ([db/compliance_actions.sql](../../db/compliance_actions.sql)) and the Neo4j `entity_names` vector index must all already exist in the provisioned services. A new table therefore has to degrade rather than abort when it is absent: recognise the `relation ... does not exist` error, name the `.sql` file to run, and keep the feature that depended on it out of the way of the ones that did not. `lib/documentRequests.ts`, `lib/ingestionRuns.ts` and `lib/compliance.ts` all do this. Required env vars live in `.env.local` (gitignored): `UPSTASH_VECTOR_REST_URL`/`_TOKEN`, `NEO4J_URI`/`_USERNAME`/`_PASSWORD`/`_DATABASE`, `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `AI_GATEWAY_API_KEY`, `NOTION_TOKEN`, `NOTION_COMPLIANCE_DATA_SOURCE_ID`.

## CORS

[middleware.ts](../../middleware.ts) applies permissive CORS to everything and short-circuits `OPTIONS`. Its matcher deliberately excludes `/.well-known/workflow/` so the workflow runtime's internal routes are untouched.

## The compliance tracker

`POST /api/syncCompliance` pulls the Notion "Compliance Tracker" — one row per regulatory enforcement action — and writes **three** stores, because each answers a question the others cannot: Upstash so `search_docs` finds an action by what it was about, Neo4j so `search_graph` walks who was penalised by whom for what, and `compliance_actions` so `search_compliance` can return *every* matching row and total the fines. Top-k similarity can do neither of those last two, and on compliance questions a quietly incomplete answer is worse than none.

**Postgres is written last, deliberately.** If the embedding or graph write fails, the previous rows and their `synced_at` still stand, so the tool keeps answering from the last good sync rather than from a half-written one. An empty read from Notion is refused outright rather than treated as a successful sync — wiping the table would answer "no, they have never been fined".

**The graph is built from the columns, with no model call.** That is the one place this data beats the PDF path: `extractGraph` must read prose to find relationships, which is where its free-form relation types come from, while these columns are already a closed vocabulary — so `PENALISED_BY` and `COMMITTED` are consistent by construction and cannot fragment.

Notion property names are asserted before mapping, once per sync. A renamed or retyped property affects every row identically, so the choice is between one loud error and a whole column silently reading as null — which downstream looks like "this action had no regulator" rather than "we failed to read it". `Regulatory Body` is exactly the property that invites this: it renders as "Regula…" in a narrow Notion column.

The pure vocabulary lives in [lib/compliance.ts](../../lib/compliance.ts) and the queries in [lib/complianceStore.ts](../../lib/complianceStore.ts), so the type, id namespace and constants can be imported without `lib/db` constructing a client at module load — the same split as `lib/figures.ts` and `lib/figureCounts.ts`.
