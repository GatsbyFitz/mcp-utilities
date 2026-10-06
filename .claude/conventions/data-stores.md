# Data stores

A Next.js 15 App Router app with two halves that share this one storage layer:

1. **Ingestion** — a durable workflow that turns an uploaded PDF into a vector index *and* a knowledge graph. See [ingestion-pipeline.md](ingestion-pipeline.md).
2. **Serving** — an MCP server at `/mcp` exposing search tools over that data. See [mcp-server.md](mcp-server.md).

| Store | Accessor | Notes |
| --- | --- | --- |
| Upstash Vector | `vectorIndex` in [lib/vector.ts](../../lib/vector.ts) | chunk text + citation metadata. **Hybrid index** — every upsert needs a `sparseVector` from [lib/sparse.ts](../../lib/sparse.ts) or it is rejected outright; see [ingestion-pipeline.md](ingestion-pipeline.md#embeddings) |
| Neo4j Aura | `readGraph`/`writeGraph`/`withSession` in [lib/graph.ts](../../lib/graph.ts) | driver is a lazily-built `globalThis` singleton, built on first query rather than at import so a config error doesn't take down every workflow step in the route |
| Neon Postgres | `sql` in [lib/db.ts](../../lib/db.ts) | `uploads` (read back by `GET /api/returnKnowledgeBase`), `document_requests`, `ingestion_runs`, `compliance_actions`, `aer_performance`/`aer_metrics` |
| Notion | `@notionhq/client` in [app/api/syncCompliance/route.ts](../../app/api/syncCompliance/route.ts) | source of the Compliance Tracker; read on demand, never at query time |

No table and no index is created by code in this repo — `uploads`, `document_requests` ([db/document_requests.sql](../../db/document_requests.sql)), `ingestion_runs` ([db/ingestion_runs.sql](../../db/ingestion_runs.sql)), `compliance_actions` ([db/compliance_actions.sql](../../db/compliance_actions.sql)), `aer_performance`/`aer_metrics` ([db/aer_performance.sql](../../db/aer_performance.sql)) and the Neo4j `entity_names` vector index must all already exist in the provisioned services. A new table therefore has to degrade rather than abort when it is absent: recognise the `relation ... does not exist` error, name the `.sql` file to run, and keep the feature that depended on it out of the way of the ones that did not. `lib/documentRequests.ts`, `lib/ingestionRuns.ts`, `lib/compliance.ts` and `lib/aerPerformance.ts` all do this. Required env vars live in `.env.local` (gitignored): `UPSTASH_VECTOR_REST_URL`/`_TOKEN`, `NEO4J_URI`/`_USERNAME`/`_PASSWORD`/`_DATABASE`, `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `AI_GATEWAY_API_KEY`, `NOTION_TOKEN`, `NOTION_COMPLIANCE_DATA_SOURCE_ID`.

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

## The AER retail performance schedules

The AER republishes Schedules 2, 3 and 4 every quarter as Excel — what each energy retailer reported about customer numbers, complaints, disconnections and hardship. `POST /api/ingestSchedule` turns one workbook into rows in `aer_performance`, and `search_aer_performance` reads them back.

**Postgres, not the vector index** — the same argument the compliance tracker makes. "How many disconnections did AGL report in Victoria last quarter" needs every matching row and arithmetic over them, and top-k similarity can neither promise it has them all nor add them up. The opposite of the [processes](ingestion-pipeline.md#processes) decision, where no aggregate was ever wanted.

**The model infers the mapping; it never emits a value.** The layout drifts between quarters, so `inferMappings` shows a model the top of each sheet and asks which column is the retailer, which is the jurisdiction, and which hold measurements — a *mapping*, in column letters. `extractAndStore` then reads the cells that mapping names. The numbers come out of the spreadsheet. A transcribed number can be wrong in a way nothing downstream detects, and a fabricated disconnection count served through a tool that reports exact totals is the worst failure available here. A wrong *mapping*, by contrast, is wrong consistently and a spot check catches it.

Three steps rather than one because step boundaries are cost boundaries: inference is the only model call, so a retry of the extraction must not re-pay for it. Both the read and the extract re-open the workbook from Blob rather than passing it between steps, for the reason `extractGraph` re-derives chunks — a Schedule 3 file runs to megabytes and the journal would hold it once per step.

**A mapping is validated against its sheet before a row is written**, by `mappingProblems` in [lib/sheetMapping.ts](../../lib/sheetMapping.ts): every named column must have a header, the header row must hold words rather than numbers (an off-by-one into the data reads the whole sheet against the wrong metrics), no column mapped twice. A sheet whose mapping fails is skipped by name rather than written half-read. `numericValue` refuses to coerce: `""`, `—`, `n/a` and `see note 4` are null, never `0`, because a zero no-one reported is a claim.

**`metric` is canonical, `metric_raw` is verbatim, and renames are the hard part.** The AER ships `Residential customers` for eight quarters and then `Residential customer numbers`. Keyed on the raw header alone that is two metrics: a query returns half the history, and the exact `SUM` the tool advertises comes back **wrong-low with a confident total attached** — a series that looks like it ended rather than one that was renamed. So inference is shown the vocabulary already recorded for that schedule (`knownMetrics`) and asked to match a header to an existing key or declare it new; `aer_metrics.aliases` keeps the trail, prepend-only, and travels in every tool response so a question asked with last quarter's wording still lands. A key that first appears in the latest period is reported as new — by `GET /api/aerSummary`, which derives it from `first_seen` — because it is either new reporting or a missed rename, and auto-merging quietly would be the worse error in the other direction: a split series is visible as a gap, a wrongly merged one is not.

What none of this catches is a *definition* change under an unchanged name. If "Disconnections" keeps its name and changes what counts as one, no name matching notices and nothing in the data can. The mitigations are provenance and the AER's own explanatory notes, which are a PDF the `search_docs` path already handles.

`source_file`, `sheet_name` and `cell_ref` are on every row, and `mapping` holds the mapping that produced it. For a regulatory number, "where did this come from" has to be answerable down to the cell, and "what did we think column E meant" has to be answerable six months later.

**Idempotent per `(schedule, period_label)`:** `replaceScheduleRows` deletes that slice and re-inserts, so re-ingesting a corrected workbook replaces a quarter rather than doubling every number in it — the discipline `replaceDocumentGraph` and `replaceActions` already follow. The uniqueness key is a `UNIQUE INDEX` rather than a `PRIMARY KEY` because it has to `COALESCE` the nullable dimensions, and Postgres allows an expression in an index but not in a key.

The split is the usual one: vocabulary and the pure helpers in [lib/aerPerformance.ts](../../lib/aerPerformance.ts), queries in [lib/aerPerformanceStore.ts](../../lib/aerPerformanceStore.ts). It is load-bearing here — it is what lets `pnpm verify:aer` feed `extractRows` a hand-written mapping and assert the numbers that come out are the numbers that went in, with no database, no model and no network.

A workbook arrives either way: uploaded from the browser straight to Blob, or fetched by the server from a URL on the AER's release page through `downloadToBlob` — the same checked fetcher an approved document request uses, told it is looking for a spreadsheet rather than a PDF. See [file-uploads.md](file-uploads.md).

`periodBounds` encodes the Australian financial year: Q1 is July–September of the first year, so `2023-24 Q3` is January–March 2024. It returns null rather than guessing, and the schedule number and period are typed in by the operator rather than read from the file — they are on the release page, not reliably inside the workbook, and a quarter filed under the wrong label is wrong in a way no later query could detect. `.xlsm` is accepted alongside `.xlsx` because the AER actually ships it: Q3 2024-25 was published macro-enabled.
