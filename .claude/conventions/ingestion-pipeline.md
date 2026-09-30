# Ingestion pipeline

`POST /api/upload` starts one `ingestPdf` workflow per file via `start()` from `workflow/api`. The workflow ([app/api/upload/workflow.ts](../../app/api/upload/workflow.ts)) is marked `"use workflow"`; every function in [app/api/upload/steps/](../../app/api/upload/steps/) is marked `"use step"`. `withWorkflow()` wraps the Next config, which compiles those directives into the generated routes under `app/.well-known/workflow/v1/` — those files (and `manifest.json`) are build artifacts, entirely gitignored. Never hand-edit them.

Step order: `createMarkdown` (Gemini PDF→Markdown) → `createEmbeddings` (Upstash Vector) → `extractGraph` (Neo4j) → `extractFigures`/`embedFigures` → `extractProcesses` → `recordUpload` (Neon Postgres `uploads` table).

There is no upload step — the browser puts the PDF in Blob before the workflow starts, so `ingestPdf` receives a `BlobInfo` rather than the bytes. See [file-uploads.md](file-uploads.md).

Retry semantics come from the error type: throw `FatalError` from `workflow` to abort the workflow, a plain `Error` to make the step retryable. `pdfReader.ts` uses both deliberately.

`extractGraph` is a separate step from `createEmbeddings` on purpose — extraction is the expensive, flaky part, and retrying it must not re-embed the document. It therefore re-derives chunks from the markdown rather than receiving them.

## The chunking invariant

[lib/chunking.ts](../../lib/chunking.ts) is the single source of truth for chunk boundaries and IDs. `createEmbeddings` and `extractGraph` both call it independently, and `search_graph` stores a `chunkId` on each Neo4j relationship that it later feeds straight to `vectorIndex.fetch()`. If those two steps ever disagree on chunking, every graph hit returns a wrong or missing excerpt. Change `chunkText`/`chunkId` only with a full re-ingest in mind — the table-row splitting added in `splitTableRows` is exactly such a change, and every document predating it keeps the old boundaries until it is re-ingested.

## Embeddings

Always `google/gemini-embedding-2` at `outputDimensionality: 1536`, matching the Upstash index and the Neo4j `entity_names` vector index. The convention is asymmetric: documents embed with `taskType: "RETRIEVAL_DOCUMENT"` and prefix `title: … | text: …`; queries embed with `taskType: "RETRIEVAL_QUERY"` and prefix `task: search result | query: …`. Keep both sides in sync.

**The Upstash index is hybrid, so every upsert must carry a `sparseVector` as well as a dense `vector`.** Upstash rejects a dense-only write outright — `UpstashError: This index requires sparse vectors` — and nothing is indexed. Build it with `sparseVector()` from [lib/sparse.ts](../../lib/sparse.ts), never by hand: it is the single source of truth for tokenisation, and the document side and the query side must tokenize identically or term overlap silently stops matching. Note the asymmetry with the dense side — **sparse takes the plain text, without the `title: … | text: …` prefix**. Every writer follows this: `createEmbeddings` (the contextualized chunk), `embedFigures` (the figure description), `syncCompliance` (the action's `embeddableText`), and `search_docs` on the query side. A new writer that forgets it does not degrade — it fails completely.

## Processes

`extractProcesses` shows each figure to the model and, when it depicts a process, stores the model's **Mermaid** transcription of it. Mermaid is the notation because one artifact serves both readers: `display_process` returns the source, which a model follows directly to answer "what happens if this is rejected?", and the viewer renders the same string as a diagram. A figure that is a bar chart, a photograph or a bare schematic returns `isProcess: false` and is skipped.

The model writes the diagram — the rules it must follow (synthetic `n0`/`n1` ids, every label quoted, `&quot;` for an embedded quote) are stated in the prompt, not imposed afterwards. What the code does is *check*: [lib/mermaidCheck.ts](../../lib/mermaidCheck.ts) validates the result, and a failure gets **one repair round** with the specific complaint fed back. This matters because invalid Mermaid does not throw anywhere useful — it renders as an empty frame in the host's iframe with nothing saying why. `end` is the trap worth knowing: it closes a `subgraph`, and most process diagrams have a box labelled "End". A diagram that survives neither validation nor repair is still stored, flagged `mermaidValid: false`, and shown as the figure crop instead — dropping it would lose the only machine-readable copy of the process.

Processes are additive, like figures: their own id namespace (`${fileName}#process-${n}`, see [lib/processes.ts](../../lib/processes.ts)), so no chunk id moves and the `chunkId`s on Neo4j relationships keep resolving. They live only in the vector index — deliberately no table of their own, for the reason [lib/figureCounts.ts](../../lib/figureCounts.ts) gives about counts: a record kept beside the index is a claim about the index that nothing keeps true. Top-k finds the right process and an id-prefix scan lists a document's, which is everything this needs; compliance actions needed Postgres because they needed aggregates over every row, and a process never does.

`POST /api/extractProcesses` re-scans a document's existing figures. It reads them from the index and never opens the PDF, renders a page or re-runs the Markdown parse — so it reaches documents ingested before this existed, and it is cheap enough to re-run whenever the prompt changes. What gets embedded is the text *on* the diagram (`nodeLabels`), not the Mermaid source: the ids are synthetic and the syntax is noise, while the box and arrow labels are the words a question actually uses.

## Graph shape

`extractGraph` writes exactly what `search_graph` reads: `(:Entity {name, type, embedding})` joined by `[:RELATES {type, description, chunkId, sourceDoc}]`. Writes are idempotent per document — `replaceDocumentGraph` deletes that document's edges, MERGEs entities (shared across documents), recreates edges, then prunes orphaned entities. Entities with no edges are never persisted, since `search_graph`'s `MATCH` can't reach them.

Cypher can't parameterize variable-length bounds, so `maxHops` is schema-clamped to 1–2 and interpolated into the query string. Keep it clamped.

See also: [workflow-steps rule](../rules/workflow-steps.md) (durability/retry mechanics, path-scoped to the workflow files) and [data-stores](data-stores.md) (the accessors these steps write through).
