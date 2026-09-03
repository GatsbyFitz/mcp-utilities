## Backlog

### High
- Build Knowledgebase with 50 Documents
- Publish MCP Server
- Fix citation metadata going forward — `pageRange()` in [lib/citations.ts](lib/citations.ts) parses `Page (N) Break` markers that nothing emits, and `version`/`publisher` are never written at ingestion, so every citation is title-only despite the README claiming title + version + page range. Adding a page-marker rule to `PARSE_PROMPT` costs nothing extra for new documents
- Backfill citation metadata for the existing corpus. `version` is parseable from the filenames (`-v401`, `-v251`, `-v30`) and `publisher` is a short hand-written map, both applied with `vectorIndex.update({ id, metadata, metadataUpdateMode: "PATCH" })` — no re-embedding. Pages are the expensive part: the persisted Markdown has no page information, so **"Re-embed all" will not fix them** (`reembedDocument` deliberately skips `createMarkdown`). Either a full re-ingest (~1,800 model calls across the current ~885 chunks) or a non-LLM pass that extracts per-page text from the PDFs and aligns it to stored chunks by fuzzy match, patching page spans in. Prefer the latter, and accept partial coverage
- Constrain relationship and entity types to a utilities vocabulary. `relationType` and entity `type` are free-form strings today: [extractGraph.ts](app/api/upload/steps/extractGraph.ts) offers five example verbs (`NOTIFIES`, `MUST_PROVIDE`, `IS_RESPONSIBLE_FOR`, `DEFINED_AS`, `REPORTS_TO`) and six categories, none of them enforced, so the model coins synonyms and the same obligation lands as `MUST_NOTIFY` on one chunk and `SHALL_NOTIFY` or `INFORMS` on the next. That fragments the graph exactly where it should join up, and the type is what `search_graph` prints in every `[R]` path line and what `/graph` colours and lists. Replace the examples with a closed vocabulary in market terms — registration and role obligations, metering data flows, settlement and reconciliation, connection and access, switching and outage process — covering both the relationship verbs and the entity categories. Note it cannot be a Zod enum: Gemini drops most JSON Schema string constraints, which is why the schema is deliberately unconstrained, so enforce after parsing the way `MAX_*` already does, mapping an unrecognised verb onto the nearest allowed term and logging the misses so the vocabulary can be grown from what the corpus actually says. Cheap to apply retroactively, unlike the page-number problem above: `reembedDocument` re-runs `extractGraph` from the saved Markdown, so **"Re-embed all" does fix this** with no PDF re-parse
- Drill-down tools so the model can iterate instead of one-shot retrieving — document/version filters on `search_docs`, `get_chunk_neighbours(chunkId, window)`, `fetch_document_section`. Single-shot search benchmarks around 8% recall@1 against ~50% when a model can search, read, and re-query; regulatory procedures cross-reference each other constantly ("as defined in clause 4.2 of…")

### Med
- Implement a Researcher Agent - With SubAgents (maybe using vercel eve)
- Implement image intelligence to save images and retrieve when required
- Multimodal embeddings so figures, diagrams and table images are retrievable. Everything indexed today is text: `createEmbeddings` embeds Markdown that Gemini produced from the PDF, so a single-line diagram, a process flow or a scanned table survives only as whatever caption the parse happened to write, and often not at all. Render each page (or each detected figure) to an image during ingestion, store it in Blob beside the Markdown, and embed it with a model that puts images and text in one shared space, so an ordinary text query can retrieve a figure. Two constraints from the current stack: the Upstash index is fixed at `google/gemini-embedding-2` / 1536 dimensions, so an image vector either has to land in that same space or live in a second index the tools query alongside the first; and citations assume a chunk has `text`, so an image hit needs its own rendering path in `lib/citations.ts` and a blob URL the client can actually display. Pairs with the image-intelligence item above — that one is about storing and serving images, this one is about making them findable. Cheaper and less disruptive than the ColPali / late-interaction option in Low, which needs multi-vector support Upstash may not have; this stays single-vector and fits the index we already run. Do the eval harness first, or there is no way to show it helped
- Batch processing for the model calls in ingestion — 50% off input and output, 24-hour target turnaround, and ingestion is a durable background workflow with no latency requirement. Researched Sep 2026 and it is available on the path this repo already uses: AI Gateway documents batch processing, and `ai@7.0.91` exports `startTextBatch` / `getBatchStatus` / `getBatchResults`. This repo is pinned at `ai@7.0.30`, which predates them, so an SDK upgrade comes first. `startTextBatch({ model, requests })` takes `TextBatchRequest = Prompt & { id }`, so a request can carry a PDF file part exactly as `createMarkdown` does today. It also takes a `webhookUrl` — which matters more than the discount, because it means a step does not have to sit polling for up to 24 hours, and the workflow runtime already exposes `/.well-known/workflow/v1/webhook/[token]`. **Aim it at `contextualizeChunks` and `extractGraph`, not `createMarkdown`.** `createMarkdown` is one call per document; those two are one call per chunk each, so at roughly 80 chunks per document they are about 160× the call volume and therefore where nearly all the spend is. The catch is turnaround: a document would take up to a day to become searchable, so batch belongs on a bulk backfill path rather than on the interactive upload the page shows progress for
- MCP sampling for query rewriting and grading retrieved chunks — the server asks the *client's* model, so those tokens land on the client's bill rather than the AI Gateway's (see the Trashed note below)
- Return resource links from the search tools instead of inlining every chunk, so the client fetches full context on demand
- Retrieval eval harness — a fixed question set with known-good sources. Nothing else in this list can be shown to have helped without one
- Semantic based chunking strategy
- Explore reranking improvements
- Add an ingestion workflow visualisation using https://elements.ai-sdk.dev/examples/workflow

### Low
- Implement Submit Market Document Tool
- Implement Logging (once supported by Claude.ai)
- Implement MCP progress notifications (once supported by Claude.ai — the upload page's own progress is done, see below)
- Evaluate visual / late-interaction retrieval (ColPali / ColQwen, ColBERT-style multi-vector) for table-heavy procedures — reported ~62% → ~84% recall on table-dense PDFs, and it sidesteps the markdown parse being lossy for tables. Big change: full re-index, and needs multi-vector support Upstash may not have
- Additional advanced techniques TBD

### Done
- ✓ Implement a resource prompt to return all documents in the database
- ✓ Implement Prompts into the MCP
- ✓ Implement Claude Code Commands for Confirming Embedding and Graph Database integrity
- ✓ Contextual Retrieval Pre-Processing
- ✓ Added NextAuth to upload pathway
- ✓ Per-step ingestion progress tracking (`/api/uploadStatus`, polled by the upload page)
- ✓ Reject duplicate uploads by file name
- ✓ Per-step failure detail, and retry a failed ingestion from its saved Markdown
- ✓ Client uploads go straight to Blob, lifting the 4.5 MB request-body limit
- ✓ `request_document` MCP tool plus an approval queue on the upload page, fetching an approved document by URL (`db/document_requests.sql`, [lib/fetchDocument.ts](lib/fetchDocument.ts))
- ✓ Rebuild a document's graph without re-embedding it (`POST /api/reextractGraph`)
- ✓ Whole-knowledge-graph viewer at `/graph` (`GET /api/graph`, canvas force layout in [lib/forceLayout.ts](lib/forceLayout.ts))

### Trashed
- ~~Implement Sampling! (Deprecated)~~ — not deprecated. Sampling is in the 2026-07-28 MCP spec, redesigned via Multi Round-Trip Requests (SEP-2322) so it no longer needs an open bidirectional stream. Moved to Med above

## Notes

### Confirming Embedding and Graph Database Integrity
Run `/check-embedding-integrity` — see [.claude/commands/check-embedding-integrity.md](.claude/commands/check-embedding-integrity.md).

### On retrieval architecture
The current stack — hybrid dense + sparse, reranked, with contextual-retrieval preprocessing and a graph walk for multi-hop — is a strong baseline and worth keeping. The consensus in 2026 is not to replace vector RAG with agentic search but to expose retrieval as tools an agent drives iteratively, which is what an MCP server already is. The gap is therefore in the tool surface (drill-down, filters, follow-up reads), not in the retrieval itself.
