# Data stores

A Next.js 15 App Router app with two halves that share this one storage layer:

1. **Ingestion** — a durable workflow that turns an uploaded PDF into a vector index *and* a knowledge graph. See [ingestion-pipeline.md](ingestion-pipeline.md).
2. **Serving** — an MCP server at `/mcp` exposing search tools over that data. See [mcp-server.md](mcp-server.md).

| Store | Accessor | Notes |
| --- | --- | --- |
| Upstash Vector | `vectorIndex` in [lib/vector.ts](../../lib/vector.ts) | chunk text + citation metadata. **Hybrid index** — every upsert needs a `sparseVector` from [lib/sparse.ts](../../lib/sparse.ts) or it is rejected outright; see [ingestion-pipeline.md](ingestion-pipeline.md#embeddings) |
| Neo4j Aura | `readGraph`/`writeGraph`/`withSession` in [lib/graph.ts](../../lib/graph.ts) | driver is a lazily-built `globalThis` singleton, built on first query rather than at import so a config error doesn't take down every workflow step in the route |
| Neon Postgres | `sql` in [lib/db.ts](../../lib/db.ts) | `uploads` (read back by `GET /api/returnKnowledgeBase`), `document_requests`, `ingestion_runs`, `compliance_actions`, `aer_performance`/`aer_metrics`/`aer_metric_definitions`/`aer_retailers`, `reference_sources` |
| Notion | `@notionhq/client` in [app/api/syncCompliance/route.ts](../../app/api/syncCompliance/route.ts) | source of the Compliance Tracker; read on demand, never at query time |

No table and no index is created by code in this repo — `uploads`, `document_requests` ([db/document_requests.sql](../../db/document_requests.sql)), `ingestion_runs` ([db/ingestion_runs.sql](../../db/ingestion_runs.sql)), `compliance_actions` ([db/compliance_actions.sql](../../db/compliance_actions.sql)), `aer_performance`/`aer_metrics` ([db/aer_performance.sql](../../db/aer_performance.sql), plus [db/aer_performance_raw_dimensions.sql](../../db/aer_performance_raw_dimensions.sql) for a table that already exists), `aer_metric_definitions` ([db/aer_metric_definitions.sql](../../db/aer_metric_definitions.sql)), `aer_retailers` ([db/aer_retailers.sql](../../db/aer_retailers.sql)), `reference_sources` ([db/reference_sources.sql](../../db/reference_sources.sql)) and the Neo4j `entity_names` vector index must all already exist in the provisioned services. A new table therefore has to degrade rather than abort when it is absent: recognise the `relation ... does not exist` error, name the `.sql` file to run, and keep the feature that depended on it out of the way of the ones that did not. `lib/documentRequests.ts`, `lib/ingestionRuns.ts`, `lib/compliance.ts`, `lib/aerPerformance.ts` and `lib/references.ts` all do this. Required env vars live in `.env.local` (gitignored): `UPSTASH_VECTOR_REST_URL`/`_TOKEN`, `NEO4J_URI`/`_USERNAME`/`_PASSWORD`/`_DATABASE`, `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `AI_GATEWAY_API_KEY`, `NOTION_TOKEN`, `NOTION_COMPLIANCE_DATA_SOURCE_ID`.

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

**The columns are quarters, not metrics.** This is the shape of a real Schedule 2 sheet, and reading it wrong is the most damaging mistake available here:

```
row 3:  Q4 2022-23 to Q4 2023-24 | Electricity      | Residential
row 4:  National                 | Customer numbers | Customer numbers | ... | Market share
row 5:  Retailer                 | Q4 2022-23       | Q1 2023-24       | ... | Q4 2022-23
row 6:  1st Energy               | 25576            | 25240            | ... | 0.0037
```

The measure is on row 4 and each column is a different **quarter**, named on row 5 — one workbook carries about five. Read as a single header row of metrics, five "Customer numbers" columns collapse onto one `(period, retailer, metric, …)` key and four are silently overwritten by `aer_performance_observation_idx`, leaving a real number from the wrong quarter under a correct-looking label. Nothing downstream could detect it. So `SheetMapping` has `metricRow` **and** `periodRow`, named that way because calling either one "the header" is what produced the mistake; `periodRow: 0` is the single-period shape that other sheets in the same workbook still use.

Fuel, customer segment and jurisdiction are stated in cells *above* the table (`B3`, `C3`, `A4`), not in columns, so `sheetDimensions` takes cell references and a column wins over a sheet-level cell where a sheet does both. Customer segment is a dimension the table did not have: without it the Residential, Small Business and Large sheets share a key and overwrite each other.

`period_label` is therefore what a number **measures** and `release_label` is which publication stated it. They differ because consecutive releases overlap by four quarters and a later one restates the earlier ones — `replaceScheduleRows` deletes every period a workbook carried rather than just the release's own, so ingest order decides the overlap and the release label makes that auditable. One consequence worth knowing: five quarters per workbook means the full history needs roughly four releases per schedule, not eighteen.

**The model infers the mapping; it never emits a value.** The layout drifts between quarters, so `inferMappings` shows a model the top of each sheet and asks which column is the retailer, which is the jurisdiction, and which hold measurements — a *mapping*, in column letters. `extractAndStore` then reads the cells that mapping names. The numbers come out of the spreadsheet. A transcribed number can be wrong in a way nothing downstream detects, and a fabricated disconnection count served through a tool that reports exact totals is the worst failure available here. A wrong *mapping*, by contrast, is wrong consistently and a spot check catches it.

Three steps rather than one because step boundaries are cost boundaries: inference is the only model call, so a retry of the extraction must not re-pay for it. Both the read and the extract re-open the workbook from Blob rather than passing it between steps, for the reason `extractGraph` re-derives chunks — a Schedule 3 file runs to megabytes and the journal would hold it once per step.

**A mapping is validated against its sheet before a row is written**, by `mappingProblems` in [lib/sheetMapping.ts](../../lib/sheetMapping.ts): every named column must have a header, the header row must hold words rather than numbers (an off-by-one into the data reads the whole sheet against the wrong metrics), no column mapped twice. A sheet whose mapping fails is skipped by name rather than written half-read. `numericValue` refuses to coerce: `""`, `—`, `n/a` and `see note 4` are null, never `0`, because a zero no-one reported is a claim.

**`metric` is canonical, `metric_raw` is verbatim, and renames are the hard part.** The AER ships `Residential customers` for eight quarters and then `Residential customer numbers`. Keyed on the raw header alone that is two metrics: a query returns half the history, and the exact `SUM` the tool advertises comes back **wrong-low with a confident total attached** — a series that looks like it ended rather than one that was renamed. So inference is shown the vocabulary already recorded for that schedule (`knownMetrics`) and asked to match a header to an existing key or declare it new; `aer_metrics.aliases` keeps the trail, prepend-only, and travels in every tool response so a question asked with last quarter's wording still lands. A key that first appears in the latest period is reported as new — by `GET /api/aerSummary`, which derives it from `first_seen` — because it is either new reporting or a missed rename, and auto-merging quietly would be the worse error in the other direction: a split series is visible as a gap, a wrongly merged one is not.

**A definition change under an unchanged name is caught separately, because name matching structurally cannot see it.** If "Disconnections" keeps its name and the AER changes what counts as one, the series does not break and no alias is added. It was invisible because the definition was never in the data — the AER states it on the workbook's notes page, which `inferMappings` classified as "not data" and discarded. That page is now read for `{ term, definition }` pairs in the same model call, and `aer_metric_definitions` keys each one on a hash of its normalised text, so a metric accumulates one row per *distinct* meaning it has ever had. A second row for a metric that already had one is the event, reported as `definitionsChanged` on the run and logged by name. Normalising before hashing means reflowed whitespace, a changed quote style or a different trailing full stop is not a change — those happen every quarter and would bury the one that matters. The capture is not recoverable after the fact: next quarter's workbook states only the new wording, so a quarter that goes uncaptured takes the old definition with it.

The definition text is extracted by a model, which looks like it crosses the line that the model never emits values. It does not: a definition is what the sheet *says*, copied verbatim, and the prompt is explicit that composing one or completing a cut-off sentence is worse than returning none. `source_file`/`sheet_name` is what keeps that honest — a stored definition is checkable against the workbook that stated it, which is the only reason storing model-extracted prose about a regulatory measure is safe at all.

## Making one series one series

`metric`/`metric_raw` survives a renamed column. The dimensions had no such pair: `extractRows` read the retailer, jurisdiction and fuel cells and stored them verbatim, so "Origin" one quarter and "Origin Energy" the next were two retailers — and because `aer_performance_observation_idx` keys on the retailer, two rows that never collided and never deduped. One company's history appearing to stop and another appearing from nowhere.

So the same discipline: `retailer`, `jurisdiction` and `fuel` hold canonical keys, `*_raw` holds the string the workbook used, kept forever because it is the only thing a wrong fold can be recomputed from. `lib/aerDimensions.ts` is pure and checked by `pnpm verify:aer-consistency`.

**It normalises, it does not guess.** Only transformations that cannot change meaning: case, whitespace, punctuation, `&` for `and`, footnote markers, and the legal-entity suffix — so "AGL Energy Ltd", "AGL Energy Limited" and "agl energy" are one key. Brand words are left alone, and `origin` stays distinct from `origin_energy`. Stripping "Energy" would fold "Origin Energy" correctly and turn "EnergyAustralia" into "australia", and **a wrongly merged series is worse than a split one**: a split shows up as a gap in the history, a merge shows up as nothing at all while quietly adding two companies' customers together. Genuine brand equivalence is a judgement for a person, recorded in `aer_retailers` ([db/aer_retailers.sql](../../db/aer_retailers.sql)), which is correctly empty until someone makes it.

Jurisdiction and fuel go onto closed vocabularies and anything unrecognised is **null, not passed through** — an unmapped value sitting in the canonical column would masquerade as one a query could filter on, while the raw string keeps it visible.

**An aggregate row is refused at the door.** A "Total" or "All retailers" row stored as an observation is summed together with the parts it totals, so every figure `search_aer_performance` reports comes back roughly double — carrying the exactness the tool advertises. `isAggregateLabel` catches it in `extractRows` rather than at query time, because excluding it at query time is something every future query would have to remember. The tool computes its own totals with window functions, which is what it already did, so a stored total is pure risk. Note this is the opposite failure from the others here: a split or a missed rename reads *low*, and is visible as a gap; a double reads *high*, and is invisible.

`source_file`, `sheet_name` and `cell_ref` are on every row, and `mapping` holds the mapping that produced it. For a regulatory number, "where did this come from" has to be answerable down to the cell, and "what did we think column E meant" has to be answerable six months later.

**Idempotent per `(schedule, period_label)`, for every period the workbook carried:** `replaceScheduleRows` takes the *set* of periods it is about to write, deletes those slices and re-inserts, so re-ingesting a corrected workbook replaces its quarters rather than doubling every number in them — the discipline `replaceDocumentGraph` and `replaceActions` already follow. A set rather than one period because the columns are quarters: deleting only the release's own while inserting five would leave the other four holding whatever an earlier release put there. The uniqueness key is a `UNIQUE INDEX` rather than a `PRIMARY KEY` because it has to `COALESCE` the nullable dimensions, and Postgres allows an expression in an index but not in a key.

The split is the usual one: vocabulary and the pure helpers in [lib/aerPerformance.ts](../../lib/aerPerformance.ts), queries in [lib/aerPerformanceStore.ts](../../lib/aerPerformanceStore.ts). It is load-bearing here — it is what lets `pnpm verify:aer` feed `extractRows` a hand-written mapping and assert the numbers that come out are the numbers that went in, with no database, no model and no network.

A workbook arrives either way: uploaded from the browser straight to Blob, or fetched by the server from a URL on the AER's release page through `downloadToBlob` — the same checked fetcher an approved document request uses, told it is looking for a spreadsheet rather than a PDF. See [file-uploads.md](file-uploads.md).

`periodBounds` encodes the Australian financial year: Q1 is July–September of the first year, so `2023-24 Q3` is January–March 2024. It returns null rather than guessing, and the schedule number and period are typed in by the operator rather than read from the file — they are on the release page, not reliably inside the workbook, and a quarter filed under the wrong label is wrong in a way no later query could detect. `.xlsm` is accepted alongside `.xlsx` because the AER actually ships it: Q3 2024-25 was published macro-enabled.

## Reference pages: what the index points at but never holds

Everything else here is a document this app has read. A reference is a page it deliberately has **not** read.

The axis that decides it is how each fails. A regulatory procedure is long and stable, so a copy is faithful for years and `search_docs` answers from its text. API documentation versions, and **stale is its worst failure** — an endpoint that moved last quarter reads exactly like one that did not, so an indexed copy is a confident lie with a citation attached.

So `reference_sources` holds a **descriptor**, not content: what the page covers and which questions it answers. `find_reference` matches a question against that and returns the URL; whoever asked reads the live page. A descriptor ages far more slowly than the page — "documents the NEM Dispatch Bidding API" survives releases that move every endpoint in it.

**The descriptor is supplied, never scraped.** This server frequently cannot reach the pages worth referencing: AEMO's developer portal runs on Azure API Management, which renders client-side, and its host does not resolve from every network. A descriptor built by fetching would describe an empty shell while looking perfectly indexed — the same class of silent-empty failure that `syncCompliance` refuses a blank Notion read for. The person submitting the URL has already read the page.

References arrive two ways, both writing through `indexReference` in [lib/referenceIndex.ts](../../lib/referenceIndex.ts) so a row added by a person and one added by a model land in the same state: the card on the upload page, and the `add_reference` MCP tool. The tool exists because the thing best placed to describe a page is whatever just read one — `find_reference` can only route to pages something registered, and this server cannot read them itself. A reference is embedded in the same call, so it is retrievable the moment the tool returns.

**The client fetches, the server routes.** That inversion is the point: the server knows what exists and which of it is relevant, and the client knows how to read a page and usually has the better network path. Neither half can do the other's. `find_reference`'s description therefore states the mechanism outright — these are pointers, fetch them, do not answer from the summary — because a description that merely says "returns relevant URLs" gets treated as a reading list.

Descriptors live in the same hybrid index under `kind = 'reference'` and the id namespace `reference#<name>`, so nothing a chunk, figure, process or compliance action occupies moves. One gap is worth knowing: a document named exactly `reference` produces `reference#figure-0`, which a reference named `figure-0` would also produce — both halves are needed, and `reservedReferenceName` refuses the half this code controls. There is deliberately no exported id *prefix*, because `reference#` is not safe to scan on.

`indexed_at` is set only after the vector write succeeds, and cleared whenever the descriptor changes. A row with a null `indexed_at` is invisible to the tool, which is a state the page shows rather than one you infer from a search that quietly never returns it. One URL may hold only one row — two would split the matches between them — so `reference_sources_url_idx` refuses the second and the route reports it as a 409 naming the clash.
