---
paths:
  - "app/api/upload/workflow.ts"
  - "app/api/upload/steps/**/*.ts"
---

# Durable workflow conventions

Applies to the `ingestPdf` pipeline. The orchestrator carries `"use workflow"`; every function it awaits carries `"use step"` as the first statement in the body. Missing that directive silently turns a step into ordinary inline code with no durability or retry.

## Retries are expressed through the error type

- `throw new FatalError(...)` (from `workflow`) — unrecoverable, aborts the run. Use for a bad input that a retry cannot fix, e.g. a failed blob fetch.
- `throw new Error(...)` — retryable. Use for transient provider failures, e.g. an empty model response.

Choose deliberately; both appear in [pdfReader.ts](../../app/api/upload/steps/pdfReader.ts).

## Step boundaries are cost boundaries

A retry re-runs the whole step. Keep expensive or flaky work in its own step so a retry doesn't redo work that already succeeded — this is why `extractGraph` is separate from `createEmbeddings` and re-derives chunks from the markdown instead of receiving them. Do not merge them to "save a pass."

## Never break the chunking contract

`createEmbeddings` and `extractGraph` both call [lib/chunking.ts](../../lib/chunking.ts) independently, and graph relationships store a `chunkId` that `search_graph` feeds straight into `vectorIndex.fetch()`. If the two steps ever chunk differently, every graph result returns a wrong or missing excerpt, with no error. Always import `chunkText`/`chunkId`; never inline a chunking loop.

## Embeddings

`google/gemini-embedding-2` at `outputDimensionality: 1536`, always — it must match the Upstash index and the Neo4j `entity_names` index. Document-side embeds use `taskType: "RETRIEVAL_DOCUMENT"`; the query side in `app/mcp/tools/` uses `RETRIEVAL_QUERY`. Keep the prefix strings (`title: … | text: …`, `entity: … | type: …`) in sync with their query-side counterparts.

## Model extraction must degrade, not abort

`extractGraph` fans out over chunks with `mapPool`, which awaits all runners — one unhandled throw discards an upload that has already paid for parsing and embedding. Catch per chunk, `console.warn` with file and chunk index, and return empty results for that chunk.

Do not add Zod `.min`/`.max` constraints to structured-output schemas: Gemini drops most string/array JSON Schema constraints, so they don't steer the model but still reject the response. Enforce limits in code after parsing, as the `MAX_*` constants do. Default arrays to `[]` — the model omits them rather than returning empty.

## Graph writes stay idempotent

Re-uploading a document must replace its edges, not duplicate them: delete by `sourceDoc`, `MERGE` entities (they're shared across documents), `CREATE` edges, then prune entities left with no relationships. Persist only entities that participate in an edge — isolated nodes are unreachable from `search_graph`'s `MATCH` and pollute the vector index.

## Generated output

`app/.well-known/workflow/v1/` is compiler output and fully gitignored. Never hand-edit it or treat `manifest.json` as a source of truth; it regenerates from the directives.
