## Backlog

### High
- Build Knowledgebase with 50 Documents
- Publish MCP Server
- Fix citation metadata going forward — `pageRange()` in [lib/citations.ts](lib/citations.ts) parses `Page (N) Break` markers that nothing emits, and `version`/`publisher` are never written at ingestion, so every citation is title-only despite the README claiming title + version + page range. Adding a page-marker rule to `PARSE_PROMPT` costs nothing extra for new documents
- Backfill citation metadata for the existing corpus. `version` is parseable from the filenames (`-v401`, `-v251`, `-v30`) and `publisher` is a short hand-written map, both applied with `vectorIndex.update({ id, metadata, metadataUpdateMode: "PATCH" })` — no re-embedding. Pages are the expensive part: the persisted Markdown has no page information, so **"Re-embed all" will not fix them** (`reembedDocument` deliberately skips `createMarkdown`). Either a full re-ingest (~1,800 model calls across the current ~885 chunks) or a non-LLM pass that extracts per-page text from the PDFs and aligns it to stored chunks by fuzzy match, patching page spans in. Prefer the latter, and accept partial coverage
- Drill-down tools so the model can iterate instead of one-shot retrieving — document/version filters on `search_docs`, `get_chunk_neighbours(chunkId, window)`, `fetch_document_section`. Single-shot search benchmarks around 8% recall@1 against ~50% when a model can search, read, and re-query; regulatory procedures cross-reference each other constantly ("as defined in clause 4.2 of…")

### Med
- Implement a Researcher Agent - With SubAgents (maybe using vercel eve)
- Implement image intelligence to save images and retrieve when required
- Implement a request doc tool
- Asynchronous batch processing for Markdown creation — move `createMarkdown` to a batch API (roughly half the per-token cost; ingestion is a durable background workflow with no latency requirement)
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
- ✓ Whole-knowledge-graph viewer at `/graph` (`GET /api/graph`, canvas force layout in [lib/forceLayout.ts](lib/forceLayout.ts))

### Trashed
- ~~Implement Sampling! (Deprecated)~~ — not deprecated. Sampling is in the 2026-07-28 MCP spec, redesigned via Multi Round-Trip Requests (SEP-2322) so it no longer needs an open bidirectional stream. Moved to Med above

## Notes

### Confirming Embedding and Graph Database Integrity
Run `/check-embedding-integrity` — see [.claude/commands/check-embedding-integrity.md](.claude/commands/check-embedding-integrity.md).

### On retrieval architecture
The current stack — hybrid dense + sparse, reranked, with contextual-retrieval preprocessing and a graph walk for multi-hop — is a strong baseline and worth keeping. The consensus in 2026 is not to replace vector RAG with agentic search but to expose retrieval as tools an agent drives iteratively, which is what an MCP server already is. The gap is therefore in the tool surface (drill-down, filters, follow-up reads), not in the retrieval itself.
