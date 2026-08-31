# Ingestion pipeline

`POST /api/upload` starts one `ingestPdf` workflow per file via `start()` from `workflow/api`. The workflow ([app/api/upload/workflow.ts](../../app/api/upload/workflow.ts)) is marked `"use workflow"`; every function in [app/api/upload/steps/](../../app/api/upload/steps/) is marked `"use step"`. `withWorkflow()` wraps the Next config, which compiles those directives into the generated routes under `app/.well-known/workflow/v1/` — those files (and `manifest.json`) are build artifacts, entirely gitignored. Never hand-edit them.

Step order: `createMarkdown` (Gemini PDF→Markdown) → `createEmbeddings` (Upstash Vector) → `extractGraph` (Neo4j) → `recordUpload` (Neon Postgres `uploads` table).

There is no upload step — the browser puts the PDF in Blob before the workflow starts, so `ingestPdf` receives a `BlobInfo` rather than the bytes. See [file-uploads.md](file-uploads.md).

Retry semantics come from the error type: throw `FatalError` from `workflow` to abort the workflow, a plain `Error` to make the step retryable. `pdfReader.ts` uses both deliberately.

`extractGraph` is a separate step from `createEmbeddings` on purpose — extraction is the expensive, flaky part, and retrying it must not re-embed the document. It therefore re-derives chunks from the markdown rather than receiving them.

## The chunking invariant

[lib/chunking.ts](../../lib/chunking.ts) is the single source of truth for chunk boundaries and IDs. `createEmbeddings` and `extractGraph` both call it independently, and `search_graph` stores a `chunkId` on each Neo4j relationship that it later feeds straight to `vectorIndex.fetch()`. If those two steps ever disagree on chunking, every graph hit returns a wrong or missing excerpt. Change `chunkText`/`chunkId` only with a full re-ingest in mind.

## Embeddings

Always `google/gemini-embedding-2` at `outputDimensionality: 1536`, matching the Upstash index and the Neo4j `entity_names` vector index. The convention is asymmetric: documents embed with `taskType: "RETRIEVAL_DOCUMENT"` and prefix `title: … | text: …`; queries embed with `taskType: "RETRIEVAL_QUERY"` and prefix `task: search result | query: …`. Keep both sides in sync.

## Graph shape

`extractGraph` writes exactly what `search_graph` reads: `(:Entity {name, type, embedding})` joined by `[:RELATES {type, description, chunkId, sourceDoc}]`. Writes are idempotent per document — `replaceDocumentGraph` deletes that document's edges, MERGEs entities (shared across documents), recreates edges, then prunes orphaned entities. Entities with no edges are never persisted, since `search_graph`'s `MATCH` can't reach them.

Cypher can't parameterize variable-length bounds, so `maxHops` is schema-clamped to 1–2 and interpolated into the query string. Keep it clamped.

See also: [workflow-steps rule](../rules/workflow-steps.md) (durability/retry mechanics, path-scoped to the workflow files) and [data-stores](data-stores.md) (the accessors these steps write through).
