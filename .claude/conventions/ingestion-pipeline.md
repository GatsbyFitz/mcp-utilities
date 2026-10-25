# Ingestion pipeline

`POST /api/upload` starts one `ingestPdf` workflow per file via `start()` from `workflow/api`. The workflow ([app/api/upload/workflow.ts](../../app/api/upload/workflow.ts)) is marked `"use workflow"`; every function in [app/api/upload/steps/](../../app/api/upload/steps/) is marked `"use step"`. `withWorkflow()` wraps the Next config, which compiles those directives into the generated routes under `app/.well-known/workflow/v1/` — those files (and `manifest.json`) are build artifacts, entirely gitignored. Never hand-edit them.

Step order: `createMarkdown` (PDF→Markdown) → `createEmbeddings` (Upstash Vector) → `extractGraph` (Neo4j) → `extractFigures`/`embedFigures` → `extractProcesses` → `recordUpload` (Neon Postgres `uploads` table).

There is no upload step — the browser puts the PDF in Blob before the workflow starts, so `ingestPdf` receives a `BlobInfo` rather than the bytes. See [file-uploads.md](file-uploads.md).

Retry semantics come from the error type: throw `FatalError` from `workflow` to abort the workflow, a plain `Error` to make the step retryable. `pdfReader.ts` uses both deliberately.

`extractGraph` is a separate step from `createEmbeddings` on purpose — extraction is the expensive, flaky part, and retrying it must not re-embed the document. It therefore re-derives chunks from the markdown rather than receiving them.

## The chunking invariant

[lib/chunking.ts](../../lib/chunking.ts) is the single source of truth for chunk boundaries and IDs. `createEmbeddings` and `extractGraph` both call it independently, and `search_graph` stores a `chunkId` on each Neo4j relationship that it later feeds straight to `vectorIndex.fetch()`. If those two steps ever disagree on chunking, every graph hit returns a wrong or missing excerpt. Change `chunkText`/`chunkId` only with a full re-ingest in mind — the table-row splitting added in `splitTableRows` is exactly such a change, and every document predating it keeps the old boundaries until it is re-ingested.

## Which model runs where

Every model id lives in [lib/models.ts](../../lib/models.ts), and the split in it is deliberate.

`createMarkdown` runs **`anthropic/claude-sonnet-5-5`** (`MARKDOWN_MODEL`, env-overridable). Everything downstream of it — `contextualizeChunks`, `extractGraph`, `extractFigures`, `extractProcesses` — stays on `EXTRACTION_MODEL`, still `google/gemini-3.5-flash-lite`.

The parse is the one call that runs **once per document**, so it is the one place a stronger model costs a document rather than a document times eighty. It is also the call the rest of the pipeline is *gated* on rather than fed by: `figurePagesFrom` finds pages to rasterise by scanning this Markdown for `[Figure:` markers, so a parse that omits them yields zero figures, zero processes and no error at all. The same PDF has parsed to 60 figures on one run and none on another. Instruction-following on that one marker rule is what the model is chosen for; quality here is not cosmetic, it is the difference between the figure pipeline existing and silently not.

The extraction steps are not left on Gemini by inertia. `contextualizeChunks` sends the whole document as the prefix of every call and relies on Gemini's *implicit* prefix caching to avoid paying for it ~80 times — Anthropic caches only against an explicit `cache_control` breakpoint, so moving that model without adding one turns the cheapest step in the pipeline into the most expensive. `extractFigures` returns normalised boxes in Gemini's own `[ymin, xmin, ymax, xmax]` convention, and a mis-ordered box still validates and still produces a plausible PNG, so changing that model needs verification against rendered crops rather than a swap.

Two provider limits the parse now has to respect, both handled in `lib/models.ts` and checked offline by `pnpm verify:markdown-model`:

- **Request size, and the two providers disagree.** Both take the PDF inline, base64'd into the body, so request size is the binding limit: Anthropic allows 32 MB (~23 MB of PDF), Gemini 20 MB for inline data (~14 MB). Claude is therefore the *more* permissive path — moving this step to Claude **raised** the largest parseable PDF from ~15 MB to ~23 MB — and that ordering is why there is no fallback: anything too large for Anthropic is too large for Gemini by a wider margin, so sending it there pays for a second request and fails anyway, with a provider error about inline data instead of a sentence naming the limit. Over the ceiling `createMarkdown` throws a `FatalError` carrying both numbers. `maxInlinePdfBytes` derives each ceiling from the provider's request limit rather than storing it, and an unrecognised provider returns null — read as "do not guess", not "unlimited". The limit nobody had encoded is the pre-existing one: `MAX_UPLOAD_BYTES` is 500 MB, so this app has always accepted PDFs it could never parse and found out one provider error at a time.
- **`max_tokens` is required** by Anthropic and defaults low enough to cut a document off mid-sentence, so the parse names `MARKDOWN_MAX_OUTPUT_TOKENS` (128k, the model's documented maximum). `finishReason === "length"` is now a `FatalError`: a truncated parse becomes the document of record for chunks, graph and figure markers, and nothing downstream re-opens the PDF to notice the tail is missing. That is the `syncCompliance` case — a half document answers questions wrongly where a missing one answers none — not the invalid-Mermaid case, where storing the broken artifact keeps the only machine-readable copy.

**The gateway is the transport, not necessarily the payer.** An `anthropic/…` model routed through AI Gateway is paid for with Vercel credits by default. `anthropicByok` attaches request-scoped BYOK (`providerOptions.gateway.byok.anthropic`), so the gateway still routes, retries and records the trace while Anthropic invoices us directly for the tokens. Request-scoped rather than a key saved in the gateway dashboard, because a dashboard setting is invisible from the code and nobody reading a call site could tell who is being billed.

It needs `ANTHROPIC_API_KEY` set in the deployment, and **degrades rather than failing**: with no key the call still runs and Vercel still pays, because a missing billing credential is not a reason to stop ingesting a document. That makes it silent, so `createMarkdown` logs which way each parse went.

Two calls cannot move to Anthropic at all, whatever the billing: `google/gemini-embedding-2` because Anthropic publishes no embedding model, and `cohere/rerank-v3.5` because it publishes no reranker. The extraction calls could, and are held back by the reasons above, not by billing.

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
