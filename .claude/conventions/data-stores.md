# Data stores

A Next.js 15 App Router app with two halves that share this one storage layer:

1. **Ingestion** — a durable workflow that turns an uploaded PDF into a vector index *and* a knowledge graph. See [ingestion-pipeline.md](ingestion-pipeline.md).
2. **Serving** — an MCP server at `/mcp` exposing search tools over that data. See [mcp-server.md](mcp-server.md).

| Store | Accessor | Notes |
| --- | --- | --- |
| Upstash Vector | `vectorIndex` in [lib/vector.ts](../../lib/vector.ts) | chunk text + citation metadata. **Hybrid index** — every upsert needs a `sparseVector` from [lib/sparse.ts](../../lib/sparse.ts) or it is rejected outright; see [ingestion-pipeline.md](ingestion-pipeline.md#embeddings) |
| Neo4j Aura | `readGraph`/`writeGraph`/`withSession` in [lib/graph.ts](../../lib/graph.ts) | driver is a lazily-built `globalThis` singleton, built on first query rather than at import so a config error doesn't take down every workflow step in the route |
| Neon Postgres | `sql` in [lib/db.ts](../../lib/db.ts) | `uploads` (read back by `GET /api/returnKnowledgeBase`), `document_requests`, `ingestion_runs`, `compliance_actions`, `reference_sources` |
| Notion | `@notionhq/client` in [app/api/syncCompliance/route.ts](../../app/api/syncCompliance/route.ts) | source of the Compliance Tracker; read on demand, never at query time |

No table and no index is created by code in this repo — `uploads`, `document_requests` ([db/document_requests.sql](../../db/document_requests.sql)), `ingestion_runs` ([db/ingestion_runs.sql](../../db/ingestion_runs.sql)), `compliance_actions` ([db/compliance_actions.sql](../../db/compliance_actions.sql)), `reference_sources` ([db/reference_sources.sql](../../db/reference_sources.sql)) and the Neo4j `entity_names` vector index must all already exist in the provisioned services. A new table therefore has to degrade rather than abort when it is absent: recognise the `relation ... does not exist` error, name the `.sql` file to run, and keep the feature that depended on it out of the way of the ones that did not. `lib/documentRequests.ts`, `lib/ingestionRuns.ts`, `lib/compliance.ts` and `lib/references.ts` all do this. Required env vars live in `.env.local` (gitignored): `UPSTASH_VECTOR_REST_URL`/`_TOKEN`, `NEO4J_URI`/`_USERNAME`/`_PASSWORD`/`_DATABASE`, `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `AI_GATEWAY_API_KEY`, `NOTION_TOKEN`, `NOTION_COMPLIANCE_DATA_SOURCE_ID`.

## CORS

[middleware.ts](../../middleware.ts) applies permissive CORS to everything and short-circuits `OPTIONS`. Its matcher deliberately excludes `/.well-known/workflow/` so the workflow runtime's internal routes are untouched.

## The compliance tracker

`POST /api/syncCompliance` pulls the Notion "Compliance Tracker" — one row per regulatory enforcement action — and writes **three** stores, because each answers a question the others cannot: Upstash so `search_docs` finds an action by what it was about, Neo4j so `search_graph` walks who was penalised by whom for what, and `compliance_actions` so `search_compliance` can return *every* matching row and total the fines. Top-k similarity can do neither of those last two, and on compliance questions a quietly incomplete answer is worse than none.

**Postgres is written last, deliberately.** If the embedding or graph write fails, the previous rows and their `synced_at` still stand, so the tool keeps answering from the last good sync rather than from a half-written one. An empty read from Notion is refused outright rather than treated as a successful sync — wiping the table would answer "no, they have never been fined".

**The graph is built from the columns, with no model call.** That is the one place this data beats the PDF path: `extractGraph` must read prose to find relationships, which is where its free-form relation types come from, while these columns are already a closed vocabulary — so `PENALISED_BY` and `COMMITTED` are consistent by construction and cannot fragment.

**The sync reports which stage failed.** `POST /api/syncCompliance` writes four upstream systems in sequence, and for a while reported every failure of any of them as the same sentence. Finding out that the compliance upsert was sending no sparse vector took a bisection across all three stores — while Upstash had said so exactly, and the route had discarded it. So the response now carries a `stage` (`notion`/`embeddings`/`vectors`/`graph`/`database`) and quotes a provider that diagnosed itself, classified by `describeSyncError` in [lib/syncErrors.ts](../../lib/syncErrors.ts) and checked offline by `pnpm verify:sync-errors`.

This is a deliberate, scoped exception to the [api-routes rule](../rules/api-routes.md) that a handler returns a generic message. That rule protects a browser from connection strings and credentials; this route is gated by `getToken` and `middleware.ts`, so its only reader is the operator, who can already see the logs. `redact()` is the backstop that keeps the exception honest. Do not "fix" this back to a generic string.

Notion property names are asserted before mapping, once per sync. A renamed or retyped property affects every row identically, so the choice is between one loud error and a whole column silently reading as null — which downstream looks like "this action had no regulator" rather than "we failed to read it". `Regulatory Body` is exactly the property that invites this: it renders as "Regula…" in a narrow Notion column.

The pure vocabulary lives in [lib/compliance.ts](../../lib/compliance.ts) and the queries in [lib/complianceStore.ts](../../lib/complianceStore.ts), so the type, id namespace and constants can be imported without `lib/db` constructing a client at module load — the same split as `lib/figures.ts` and `lib/figureCounts.ts`.

## Reference pages: what the index points at but never holds

Everything else here is a document this app has read. A reference is a page it deliberately has **not** read.

The axis that decides it is how each fails. A regulatory procedure is long and stable, so a copy is faithful for years and `search_docs` answers from its text. API documentation versions, and **stale is its worst failure** — an endpoint that moved last quarter reads exactly like one that did not, so an indexed copy is a confident lie with a citation attached.

So `reference_sources` holds a **descriptor**, not content: what the page covers and which questions it answers. `find_reference` matches a question against that and returns the URL; whoever asked reads the live page. A descriptor ages far more slowly than the page — "documents the NEM Dispatch Bidding API" survives releases that move every endpoint in it.

**The descriptor is supplied, never scraped.** This server frequently cannot reach the pages worth referencing: AEMO's developer portal runs on Azure API Management, which renders client-side, and its host does not resolve from every network. A descriptor built by fetching would describe an empty shell while looking perfectly indexed — the same class of silent-empty failure that `syncCompliance` refuses a blank Notion read for. The person submitting the URL has already read the page.

References arrive two ways, both writing through `indexReference` in [lib/referenceIndex.ts](../../lib/referenceIndex.ts) so a row added by a person and one added by a model land in the same state: the card on the upload page, and the `add_reference` MCP tool. The tool exists because the thing best placed to describe a page is whatever just read one — `find_reference` can only route to pages something registered, and this server cannot read them itself. A reference is embedded in the same call, so it is retrievable the moment the tool returns.

**The client fetches, the server routes.** That inversion is the point: the server knows what exists and which of it is relevant, and the client knows how to read a page and usually has the better network path. Neither half can do the other's. `find_reference`'s description therefore states the mechanism outright — these are pointers, fetch them, do not answer from the summary — because a description that merely says "returns relevant URLs" gets treated as a reading list.

Descriptors live in the same hybrid index under `kind = 'reference'` and the id namespace `reference#<name>`, so nothing a chunk, figure, process or compliance action occupies moves. One gap is worth knowing: a document named exactly `reference` produces `reference#figure-0`, which a reference named `figure-0` would also produce — both halves are needed, and `reservedReferenceName` refuses the half this code controls. There is deliberately no exported id *prefix*, because `reference#` is not safe to scan on.

`indexed_at` is set only after the vector write succeeds, and cleared whenever the descriptor changes. A row with a null `indexed_at` is invisible to the tool, which is a state the page shows rather than one you infer from a search that quietly never returns it. One URL may hold only one row — two would split the matches between them — so `reference_sources_url_idx` refuses the second and the route reports it as a 409 naming the clash.
