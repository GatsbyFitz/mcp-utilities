# mcp-utilities

A Next.js 15 app that ingests PDFs into a vector index and a knowledge graph, then serves both over an MCP server at `/mcp` so an LLM client (e.g. Claude Code) can search them with citations.

## Architecture summary

The app is one Next.js 15 deployment split into two halves that never call each other directly — they only agree on shared storage and a shared chunking function:

```
Browser ──upload()──> Vercel Blob             MCP client (e.g. Claude Code)
    │   (direct; bypasses the 4.5 MB               │
    │    function body limit)                      ▼
    ▼                                         GET/POST /mcp
POST /api/upload  (JSON manifest)                  │  (mcp-handler)
    │  (durable workflow, one per file)     ┌───────┴────────┐
    ▼                                       ▼                ▼
1. createMarkdown    (Gemini PDF→MD)   search_docs       search_graph
2. createEmbeddings → Upstash Vector   (vector + sparse   (graph walk +
3. extractGraph     → Neo4j Aura        hybrid + rerank)   vector-seeded)
4. recordUpload     → Neon Postgres         │                │
                                            ▼                ▼
                                       Upstash Vector     Neo4j Aura
                                                        + Upstash Vector
                                                          (excerpt fetch)
```

- **Ingestion** (`app/api/upload/workflow.ts`, marked `"use workflow"`) is durable — each step is a separately retryable unit, compiled by `withWorkflow()` into generated routes under `app/.well-known/workflow/v1/` (gitignored build artifacts, never hand-edited).
- **Serving** (`app/mcp/route.ts`) is a stateless MCP handler that only reads from the stores ingestion wrote to. It never touches the workflow.
- The two halves are coupled by exactly one invariant: `lib/chunking.ts` must produce identical chunk boundaries/IDs for both `createEmbeddings` and `extractGraph`, because `search_graph` takes a `chunkId` off a Neo4j relationship and fetches that exact chunk straight out of Upstash Vector. Disagreement here silently breaks graph-result citations.

| Store | Written by | Read by | Purpose |
| --- | --- | --- | --- |
| Vercel Blob | the browser, direct | `kb://documents` resource (URL only) | original PDF bytes |
| Upstash Vector | `createEmbeddings` | `search_docs`, `search_graph` | chunk text + citation metadata, semantic/hybrid search |
| Neo4j Aura | `extractGraph` | `search_graph` | entities + relationships extracted from chunks |
| Neon Postgres | `recordUpload` | `kb://documents` resource | one row per ingested document (name, chunk count, size, blob URL) |

See [.claude/conventions/](.claude/conventions/) for the full architecture writeup (this section is a summary of it).

## Ingestion pipeline

`POST /api/upload` starts one workflow per file, with these steps in order:

1. **createMarkdown** — converts the PDF to Markdown via Gemini
2. **createEmbeddings** — chunks the markdown (`lib/chunking.ts`) and embeds each chunk into Upstash Vector (`google/gemini-embedding-2`, 1536 dimensions)
3. **extractGraph** — re-derives the same chunks and extracts entities/relationships into Neo4j
4. **recordUpload** — writes a row to the Neon `uploads` table

There is no upload step: the browser puts the PDF in Blob before the workflow starts (see below), so ingestion begins from a blob URL.

`createEmbeddings` and `extractGraph` chunk independently but must agree on chunk boundaries and IDs (`lib/chunking.ts` is the single source of truth) — `search_graph` uses a chunk's `chunkId` to fetch its text straight out of the vector index.

### Uploads go straight to Blob

A Vercel function caps its request body at 4.5 MB and rejects anything larger at the platform edge with `413 FUNCTION_PAYLOAD_TOO_LARGE`, before the handler runs. The limit is not configurable, and regulatory PDFs exceed it routinely. So file bytes never pass through a route handler:

1. The browser calls `upload()` from `@vercel/blob/client` with `multipart: true`, uploading directly to Blob (up to 5 TB, parts in parallel, failed parts retried) and reporting progress via `onUploadProgress`.
2. `POST /api/upload/token` issues the client token via `handleUpload()`. It is auth-gated, and it is where an upload is refused — the duplicate-name check, `allowedContentTypes` and `maximumSizeInBytes` all live in `onBeforeGenerateToken`, so a rejected file never transfers a byte. Those constraints are baked into the issued token and enforced by Blob, not by the browser.
3. `POST /api/upload` then receives a small JSON manifest of finished uploads and starts one workflow per file, re-checking duplicates authoritatively since a client can skip the token route.

`onUploadCompleted` is deliberately unused: it is a Blob-to-server callback that cannot reach `localhost`, so relying on it would make local development require a tunnel.

This is the standard for every client upload in this repo, not a special case for PDFs — see [.claude/conventions/file-uploads.md](.claude/conventions/file-uploads.md). Server-side `put()` for content the app generates itself (`uploadMarkdown`) is unaffected.

### Duplicate uploads

`POST /api/upload` rejects a file whose name already exists in the `uploads` table, comparing case-insensitively and ignoring surrounding whitespace, and also collapses the same name repeated within one batch. The rest of the batch still ingests; the response carries `skipped: string[]` alongside `fileCount` and `runs`, and the upload page lists the skipped names.

This is a name check rather than a content check because the file name *is* the document's identity downstream: chunk IDs are `${fileName}-${index}`, vector metadata carries `source = fileName`, and graph edges carry `sourceDoc = fileName`. Two documents sharing a name overwrite each other's chunks and edges, and deleting either one wipes both. If the duplicate lookup itself fails the request fails closed — nothing is ingested — since a duplicate corrupts the existing document. To replace a document, delete it first; the Delete action already removes the blob, row, vectors and graph.

Two same-named files uploaded in separate requests within seconds of each other can still both start, since the `uploads` row is only written by `recordUpload` at the very end. A unique index on `LOWER(TRIM(name))` in Neon would close that race, but nothing in this repo creates the table.

### Progress tracking

`POST /api/upload` returns a `runs` array pairing each file name with its workflow run ID. `GET /api/uploadStatus?runId=…` (auth-gated, repeatable param) resolves those IDs live against the workflow runtime — `getRun()` for the run status and `getWorld().steps.list()` for per-step status and retry attempt — and folds them against the ordered step list in [lib/ingestSteps.ts](lib/ingestSteps.ts). The upload page polls it every 2s and renders a per-file progress bar, refreshing the knowledge-base table only once the runs reach a terminal state (the rows do not exist until `recordUpload`, the final step).

Nothing about a run is persisted: status comes from the runtime on each request, so run IDs live only in the browser tab that started the upload (mirrored to `sessionStorage` for reload recovery). A run the runtime no longer knows about reports as `unknown`. Vercel's own dashboard (Project → Observability → Workflows) remains the deeper view for debugging.

Each step carries the runtime's own failure message (`error.message` / `error.code`), not just which step failed, so the UI can show *why* embedding failed rather than only *that* it did. Stack traces stay in the server log.

### Retrying a failed ingestion

A failed run is terminal — the runtime will not resume it in place, and re-enqueueing one is a no-op. Instead, `ingestPdf` records a **resume point** (`markResumePoint`) into the workflow journal as soon as the Markdown is persisted: the file name, size, blob URLs and Markdown URL, all in one small step output.

`POST /api/retryUpload { runId }` reads that one step (resolving only it — every other step's serialized input carries the whole PDF or the whole Markdown) and starts a `resumeIngest` run from it. That workflow fetches the saved Markdown and runs contextualise → embed → extract graph → record, so **neither the upload nor the Gemini PDF→Markdown parse runs again**. The response returns the new run ID, which the client tracks in place of the old one.

`uploadStatus` reports `resumable: true` only for a failed run that reached the resume point. A run that failed earlier — during upload or the parse itself — has no saved Markdown to reuse, so retry is refused with a 409 and the file must be uploaded again.

`resumeIngest`'s tail is deliberately identical to `ingestPdf`'s and `reembedDocument`'s: same steps, same order, so chunk boundaries and IDs stay in sync between Upstash and Neo4j. Keep all three in step.

### Rebuilding the graph without re-embedding

`POST /api/reembed` rebuilds everything — contextualise, embed, extract, in that order. When it is the *extraction* that changed (a new prompt, a constrained relationship vocabulary, a different model) and the vectors are already correct, that pays for one model call per chunk plus a full re-embed to arrive at the same vectors it started with.

`POST /api/reextractGraph` (`{ id }` for one document, no body for all) runs the `reextractGraph` workflow: fetch the saved Markdown, `extractGraph`, done. The knowledge base page exposes it as **Rebuild graph**, per row and for the whole corpus.

This is safe to run on its own because `extractGraph` takes the markdown, not the contextualised chunks — nothing it produces depends on the embedding pass. It does still rest on the chunking invariant: `extractGraph` re-derives chunks with `chunkText` and stores a `chunkId` on every relationship that `search_graph` feeds straight to `vectorIndex.fetch()`. The same Markdown through the same `chunkText` yields byte-identical IDs, so the edges keep resolving. **After changing [lib/chunking.ts](lib/chunking.ts), re-extraction alone is not enough** — the new IDs will not exist in Upstash and every graph hit returns a missing excerpt. Re-embed then, so both sides are rebuilt under the same rules.

It writes no `chunks` count. That column belongs to whatever last embedded the document, so `recordMarkdownUrl` only ever touches `markdown_url`, and then only to self-heal a legacy row that had none and had to regenerate its Markdown.

### Requesting a document that isn't there

`request_document` is an MCP tool the model calls when `search_docs` and `search_graph` both come up empty — a gap in the corpus rather than a retrieval failure. It writes a row to `document_requests` and returns text that tells the model to say a request was *logged*, not that the document is now available.

It records; it never fetches. `/mcp` is public (`middleware.ts` exempts it deliberately, for external MCP clients), so this is an unauthenticated write, and a tool that downloaded a model-supplied URL server-side would be an open SSRF proxy. The URL is stored as a suggestion and shown to the operator. Abuse is bounded by per-field length caps and a ceiling of 200 pending requests, and duplicate titles join the existing request instead of adding a row.

The tool asks the model to do two things before it will record anything. It must set `checkedIndexedDocuments`, having read `kb://documents` — search missing a document is not proof it is absent, since a file name rarely resembles the official title. And it is pressed to supply `sourceUrl`, a direct link to the PDF: a request carrying one can be approved and ingested in a single action, while one without it stalls until a human finds the file, so the response says which of the two it produced and the queue flags the ones still needing a link.

Neither is taken on trust. The server re-checks the corpus itself, comparing *tokens* rather than substrings — a request carries a prose title ("B2B Procedure: Technical Delivery Specification") while the corpus stores a file name ("B2B-Procedure-Technical-Delivery-Spec-v3.2.pdf"), and no substring of one appears in the other, which is why the original `LIKE` check never fired. A likely match is returned to the model with its overlap score instead of a request being queued.

`GET/POST /api/documentRequests` is the review queue, rendered on the upload page. Rejected requests are hidden by default — the queue is a to-do list and a decision already made is not on it — behind a toggle that appears only when there are any, since a rejection is the only record that a gap was ever raised. Approving is the only thing that fetches, and it re-derives everything rather than trusting the request: the operator can replace the URL and the file name, the name is checked against `uploads` the same way a browser upload is, and the download goes through [lib/fetchDocument.ts](lib/fetchDocument.ts), which

- requires `https:`,
- resolves the host and refuses any answer in a loopback, private, CGNAT, link-local (including the cloud metadata address), multicast or unique-local range — checking IPv4-mapped IPv6 in both the dotted and the hex form the resolver actually returns,
- follows redirects by hand, re-validating every hop, because `fetch`'s automatic following would check only the first URL and then chase a 302 into the private network,
- requires a PDF content type, and
- streams to Blob through a counter that aborts the transfer the moment it passes `MAX_UPLOAD_BYTES`, rather than discovering the size afterwards.

On success it starts `ingestPdf` with the same `BlobInfo` shape a browser upload produces and hands the run ID back, so the request lands in the same per-step progress card as any other upload. A failed fetch flips the row to `failed` with the reason attached.

`document_requests` is not created by application code — run [db/document_requests.sql](db/document_requests.sql) once against the database, as with `uploads`. Until then the queue endpoint returns empty with a notice saying so rather than an error.

### Recovering an ingestion that never finished

The PDF→Markdown parse is the most expensive thing the pipeline does, and it is banked in Blob long before the steps that actually tend to fail. Nothing durable used to point at it: `uploads` gets its row from `recordUpload`, the *last* step, and until then the only handle on a run was its run ID, which lived in `sessionStorage` in the tab that started the upload. Refresh that tab and the Markdown was stranded — paid for, sitting in Blob, unreachable.

Two features cover this, and they answer different questions.

**`ingestion_runs` is the record going forward.** A row is written by `POST /api/upload` before the workflow starts, `markResumePoint` fills in `markdown_url` the moment the parse lands, and `recordUpload` deletes the row once the document is real. So the table's contents *are* the ingestions needing finalisation, and `GET /api/incompleteIngestions` is just a read of it. `POST` with a file name finishes one from its saved Markdown. Rows are keyed by normalised file name rather than run ID, because a retry starts a *new* run for the same document — and because the primary key then also closes a gap the `uploads` duplicate check cannot see: two uploads of one name in flight at once, neither of them in `uploads` yet, quietly overwriting each other's chunks and graph edges.

It also fixes retrying. `POST /api/retryUpload` reads the resume point from this row first and from the workflow journal only as a fallback. The journal path is the one that produced *"saved resume point is unreadable"*: `hydrateStepIO` swallows a hydration failure and leaves the step's output as raw bytes, so the run's Markdown was reachable in principle and unreadable in practice.

**`GET /api/strandedMarkdown` is the retrospective scan**, and the reason the table alone is not enough: a row only exists for runs started since the table did. Blob knows about all of them, because both halves of a run leave a named artifact — `markdown/<uuid>-<file name>.md` and `uploads/<uuid>-<file name>` — so pairing those by file name and subtracting what is already in `uploads` reconstructs the list retroactively, with no migration and nothing to keep in sync. Where one name has several parses, the newest wins. A result is listed only when the original PDF is still in Blob too, since finishing needs it for figure extraction and for the blob URL that ends up in citations.

The scan is manual, behind a button on the upload page, because it lists every Markdown and every PDF in the store — far too much work for a page load — and because it is a recovery tool, not a live view. Restarting one of its suggestions writes the `ingestion_runs` row the original run never had, so tracking hands over to the first feature from there.

Both restart paths take a file name and nothing else. The server re-derives the blob URLs itself, so a caller can name a document but never point the pipeline at a blob of its choosing.

### Figures

`createMarkdown` describes a diagram as `[Figure: ...]` and discards the pixels, so a question whose answer is a process flow used to retrieve, at best, a one-line caption. Two steps at the end of ingestion fix that.

`extractFigures` renders only the pages that already carry a `[Figure: ...]` marker — the parse emits those and the page-break markers, so the pages worth rendering are known without an extra model call — asks the model where each figure sits on the page, and crops it.

**The box comes back as four named fields, not an array**, and that is not cosmetic. Gemini's own normalised-box convention is `[ymin, xmin, ymax, xmax]`; asking for `[x0, y0, x1, y1]` and reading it positionally asks the model to abandon the ordering it was trained on, and gives no signal at all when it doesn't. Every number is still in range, the box still passes validation, and the crop silently comes out transposed — a tall narrow slice down the left of the page, with the diagram cut off at its right edge. Field names cannot be transposed. Min and max are still sorted rather than trusted, since which number is the near edge is the one thing left to get backwards and it costs nothing to recover, and every box is padded by `FIGURE_BOX_PADDING` (1.5% of the page, clamped to it): a clipped axis label is lost for good, while surrounding whitespace costs almost nothing. An unusable box is logged with its raw numbers, because the failure mode is otherwise invisible — a mislocated box still produces a plausible-looking PNG.

The geometry itself lives in `cropGeometry`/`usableBox` in [lib/figures.ts](lib/figures.ts) rather than in the step, so it can be tested without a PDF, a model call or the workflow runtime. It is verified both arithmetically and through mupdf against a synthetic page: the crop lands on the authored rectangle, keeps its aspect ratio (so a transposed box would fail), includes the whole of it with margin to spare, and contains nothing drawn outside it. A wide box scales down to fit `maxEdgePx` rather than being truncated to it. Rendering uses [mupdf](https://www.npmjs.com/package/mupdf), which is pure WASM: `.npmrc` sets `ignore-scripts=true` and native builds have to be allowlisted in `pnpm-workspace.yaml`, which is how the `unrs-resolver` deploy failure happened. **It is listed in `serverExternalPackages` and must stay there.** Bundled, its Node loader breaks twice over: webpack's interop leaves `createRequire` undefined, so the first call into it throws `TypeError: a is not a function`, and the build machine's absolute path to `mupdf-wasm.js` is inlined, which cannot resolve under `/var/task` at runtime. Neither shows up locally — `next dev` does not bundle server code the same way — so this only appears once deployed. A bounding box that is missing or implausibly small falls back to the whole page, since a page is worth more than a dropped figure or a sliver of one.

Each figure is rendered **twice, at two resolutions, for two different consumers** — they are not the same image and must not be collapsed into one. The stored PNG is deliberately generous (scale 4, ~288 DPI, capped at 2048px on the longest edge) because it is what a reader opens to study a dense diagram, and no API limit applies to it. A second, smaller render (768px) exists only as the `inlineData` part of the embedding request. Because mupdf rasterises from the PDF each time, the small copy is a fresh render of the same clip rectangle rather than a downscale, so the stored image loses nothing to its existence.

`embedFigures` embeds each figure from its description **and** its pixels, through `providerOptions.google.content` — `gemini-embedding-2` is natively multimodal and takes an array of parts per value, aggregating the parts of one entry into a single vector. That keeps figures in the same model, the same 1536 dimensions and the same vector space as every text chunk, so there is no second index, no second credential and nothing to change on the query side: `search_docs` already embeds its query with this model. `inlineData` rather than `fileData`, because `fileUri` expects a Files API or GCS URI, not a public Blob URL. The model id lives in [lib/embedding.ts](lib/embedding.ts) and is shared with `createEmbeddings` — note it is `gemini-embedding-2`, *not* the `-preview` id used in the provider's multimodal example, since figures must sit in the same space as the chunks they are ranked against.

**The API limits shape the batching.** A request may carry at most 6 images, and the *overall* input budget is 8,192 tokens shared across every image and description in it. `embedMany` puts all values in one HTTP request regardless of image count, so `embedFigures` batches at `MAX_FIGURES_PER_EMBED_REQUEST` (4, leaving headroom under both). That constant is derived from the API, not a throughput knob — raising it to save round trips brings back a hard rejection on any document with more than six figures. `values` and `content` are positionally paired and sliced together, since misaligning them would attach every vector to the wrong figure's metadata with no error.

**Figures are additive, which is the point.** They use their own vector-ID namespace (`${fileName}#figure-${n}`, distinct from `chunkId`'s `${fileName}-${i}`), so no text chunk ID moves and every `chunkId` stored on a Neo4j relationship keeps resolving. Existing documents therefore gain figures through `POST /api/extractFigures` — **Extract figures** on the knowledge-base page, per row or for the whole corpus — with no re-ingest. It is also the cheap way to iterate on the figure prompt: re-running costs the page renders and one vision call per figure-bearing page, not a re-embed.

A non-zero **Figures** count in the knowledge base table opens that document's figures in place — `GET /api/documentFigures?name=…` reads them from the vector index by id prefix rather than by listing the Blob folder, because the index also holds the description that was embedded with each image and the page it came from. Each thumbnail links to the full-resolution PNG, which is rendered far larger than it displays. Extracting figures for a document that already has some warns first: `embedFigures` clears its figure vectors and `extractFigures` deletes its stored PNGs before anything new is written, so a re-run replaces existing work and pays a vision call per figure-bearing page to do it.

The knowledge base table shows a **Figures** count per document. It is counted from the vector index rather than stored on the `uploads` row alongside `chunks`: Upstash has no count-by-filter (`range` takes a prefix and cursor but no metadata filter, and `info()` reports only totals), but figure ids are `${fileName}#figure-${n}`, so one id-only scan of the index yields counts for every document at once — one request per 1,000 vectors. The stronger reason is that a stored count is a claim about the index that nothing keeps true: a partly-failed `embedFigures`, a re-extraction finding fewer figures, or a manual delete would all leave it quietly wrong. A dash rather than `0` means the count could not be read, which is not the same as having no figures.

**`search_docs` returns figures as actual images, not just links.** A result that *is* a picture is not served by a URL: the Markdown `![…](…)` only renders in a client that renders Markdown and will fetch a remote image, and the model answering the question never sees the pixels either way. So figure results are also appended to the tool response as MCP image content blocks, each preceded by a text block naming its result number — image content has no caption field, so without that label the model cannot tell which result a picture belongs to or cite it. [lib/figureImages.ts](lib/figureImages.ts) does the fetching, bounded rather than universal: at most `MAX_INLINE_FIGURE_IMAGES` (4), each under `MAX_INLINE_FIGURE_BYTES` (1.5 MB), since stored figures run to 2048px and base64 is ~1.33×, which would put eight of them at several megabytes on a transport that buffers the whole response. A figure that 404s, exceeds the budget, comes back as something other than an image, or fails outright is dropped rather than failing the search — it keeps the Markdown link it already had, so the cap costs reach, not access.

A figure result also renders as a Markdown image followed by its description, built by `figureLine()` in [lib/citations.ts](lib/citations.ts) so every tool emits it identically. Its PNGs live under `figures/<file name>/` in Blob — a prefix rather than a uuid-first leaf name, so `deleteDocument` can list and remove them instead of orphaning them.

**`pnpm verify:multimodal` checks the image is really reaching the model.** If `content` is dropped anywhere in transit the call still succeeds and still returns a 1536-dimension vector — it has simply never seen the image, and nothing throws or logs. That is not a breakage: `values` still carries the description, so figures stay retrievable, cited and displayed. What it decides is whether you are getting the multimodal upgrade you are paying request payload for, and it stops "multimodal didn't help on this corpus" being concluded about a path that was never switched on.

[The script](scripts/verify-multimodal-embedding.mjs) runs in two stages because there are two places it can be lost and the fix differs. Stage A stubs `fetch` and asserts what the SDK *would* send — offline, no credentials, and it doubles as the only guard on the image-per-request batching, which is invisible from the call site. Stage B needs `AI_GATEWAY_API_KEY` and embeds one description with and without an image, failing if the vectors match; it skips cleanly without a key. If Stage B fails, setting `GOOGLE_GENERATIVE_AI_API_KEY` routes this one call through `@ai-sdk/google` directly and removes the gateway hop entirely.

### What a response costs

Tokens are the running cost of this system, and they are spent in two places that behave very differently.

**In a tool response.** Both search tools used to send every result's text twice — once in the rendered block the model reads, once again inside `structuredContent`. Nothing reads the second copy: the rendered block is what gets cited, and a programmatic consumer needs identifiers, citations and scores rather than a duplicate of the prose. Dropping it halves the response — measured at 47% on eight typical chunks, 49% when one of them is the 400-row obligations table. `kb://documents` is emitted compact rather than pretty-printed for the same reason: a 50-document list spends 19% of itself on indentation that only a human would read.

**Figures are billed by area**, roughly `width × height / 750` tokens, which makes them the most expensive thing in a response by a wide margin: four 2048px crops come to ~15,000 tokens, more than every text result combined. So each figure is rendered a *third* time at `MAX_INLINE_FIGURE_EDGE_PX` (1024) and that copy is what a tool returns inline — ~1,000 tokens instead of ~3,800, with labels still legible to a model that only has to read them. The stored crop is untouched, because it has a different job: it is what a person opens from a citation. Figures indexed before this existed have no small copy and fall back to the stored one, which is correct and merely expensive. It is stored rather than downscaled on demand because there is no raster library here — mupdf rasterises from the PDF, and the PDF is not in hand when a tool answers a query.

**In ingestion**, `contextualizeChunks` dominates everything else. It sends the *whole document* as the prefix of every call and varies only the chunk at the end, so its input is roughly the document times the chunk count — at ~80 chunks that is about 80× the document per ingestion, far more than `createMarkdown` or `extractGraph`. The prefix is byte-identical across those calls, which is exactly what Gemini's implicit prefix caching is for, but a cache only helps against a request it has already seen: firing five identical-prefix calls at once into a cold cache pays full price for all five. The first call is therefore made alone, before the rest fan out, which costs one call's latency on a step that already takes minutes. **This has not been measured against real billing** — it is sound in principle and free to do, not a proven saving.

### Browsing the knowledge graph

`/graph` renders the whole extracted graph — every `(:Entity)-[:RELATES]->(:Entity)` in Neo4j, not the subgraph around one query the way `search_graph` does. `GET /api/graph` reads it with no embedding step and no search term, ordering edges by the combined degree of their endpoints so a graph past the cap is the well-connected core rather than an arbitrary slice (2,000 edges by default, `?limit=` up to 6,000). Nodes are derived from the returned edges, which loses nothing: `extractGraph` never persists an entity with no relationships.

The page draws to a canvas with a force layout in [lib/forceLayout.ts](lib/forceLayout.ts) — written here rather than pulled in, since d3-force or react-force-graph is a dependency and a bundle for about sixty lines of physics. Repulsion is bucketed into a uniform grid and only evaluated between adjoining cells, which keeps it roughly linear. Layout warmup is budgeted in milliseconds rather than ticks: a tick costs ~2 ms at 400 nodes and ~30 ms at 2,500, so a fixed tick count is a brief pause on a small graph and a multi-second frozen tab on a large one. The rest settles under `requestAnimationFrame`, which re-fits the view once when it comes to rest unless the user has already framed it.

Node colour is the entity type (the most common types get the palette, the tail shares one neutral colour), node size is degree in the current view, and labels appear only for hubs until you zoom in. Filtering by source document rebuilds the layout from just those edges rather than dimming, so degrees and clustering reflect what is on screen. Clicking a node lists its relationships with type, description and source document, each neighbour clickable in turn.

## MCP server features

Everything below is registered in `app/mcp/tools/index.ts`, `app/mcp/prompts/index.ts`, and `app/mcp/resources/index.ts`, then wired together in `app/mcp/route.ts`.

### Tools

**`search_docs`** — Hybrid search over document chunks: semantic vector search (Gemini embeddings) combined with exact-term/sparse matching (for codes and IDs like `IN008-24`), then reranked with `cohere/rerank-v3.5`. Returns a numbered, citation-annotated text rendering plus `structuredContent`. Use for direct factual lookups within a topic.

**`search_graph`** — Searches the Neo4j knowledge graph for entities and relationships extracted from uploaded documents. Seeds from a vector similarity search over entity names, walks 1–2 hops of `[:RELATES]` edges, then pulls supporting document excerpts for the closest-hop relationships. Returns relationship paths (`[R1]`, `[R2]`, …) plus excerpts (`[1]`, `[2]`, …) with citations. Use for relational questions — obligations or dependencies between parties, how concepts connect, definitions spanning documents.

**`echo`** — Trivial diagnostic tool that echoes back a message. Useful for confirming the MCP connection is alive.

Both search tools:
- render numbered citation headers (document title, version, page range) via `lib/citations.ts`, plus a deduplicated source list with blob URLs. Version and page span are written into vector metadata at ingestion (`lib/documentMeta.ts`, `chunkTextWithPages`); a document ingested before that existed shows title only until `POST /api/backfillCitations` runs, and pages need a re-ingest since older Markdown has no page markers
- catch errors into `{ isError: true }` rather than throwing
- share embedding conventions: queries embed with `taskType: "RETRIEVAL_QUERY"` and prefix `task: search result | query: …`, matching how documents were embedded (`RETRIEVAL_DOCUMENT`, `title: … | text: …`)

### RAG capabilities

The two search tools together implement two complementary retrieval strategies over the same underlying chunks:

- **Hybrid dense + sparse retrieval** (`search_docs`) — every query is embedded with `google/gemini-embedding-2` (1536-dim, `RETRIEVAL_QUERY` task type) *and* turned into a sparse vector (`lib/sparse.ts`) for exact-term matching, so a query like `"IN008-24"` still surfaces the right chunk even though semantic similarity alone would miss an opaque ID. Upstash Vector blends the two with `WeightingStrategy.IDF`. Candidates are then reranked with `cohere/rerank-v3.5` to fix ordering imprecision from the retrieval step before the top `topN` are returned. This is standard single-hop RAG: retrieve, rerank, cite.
- **Graph RAG** (`search_graph`) — instead of retrieving chunks directly, the query embedding first finds the closest *entities* (`entity_names` vector index in Neo4j), then walks 1–2 hops of `[:RELATES]` edges outward from those entities. This answers questions a chunk-similarity search structurally can't: multi-hop relationships, obligations between named parties, or facts that only emerge by connecting two documents that never appear in the same chunk. It only pulls chunk text back in as *supporting evidence* for the relationships it finds, via the shared `chunkId`.
- **Citations as a first-class concern, not a footnote** — both tools route through `lib/citations.ts` for a consistent numbered-header format (title, version, page range) and deduplicate source URLs so a model synthesizing an answer can cite precisely and cheaply, rather than re-deriving citation text per result.
- **Tool descriptions steer the calling model**, not just document it — `search_docs` and `search_graph`'s registered descriptions explicitly tell the model when to prefer the other tool, and the `research-topic` prompt hard-codes a "call both, then reconcile disagreement" workflow rather than leaving retrieval strategy to the model's judgment alone.

### Prompts

**`research-topic`** — A user-triggered template (`/mcp__<server>__research-topic` in Claude Code) that instructs the model to call `search_docs` then `search_graph` for a given topic and synthesize both result sets into one cited answer, flagging disagreement between the two rather than papering over it.

### Resources

**`kb://documents`** — Lists every document currently indexed, read straight from the Neon `uploads` table (id, name, chunk count, size, upload time, blob URL). Reflects the ingestion pipeline's final step.

### MCP Apps (interactive UI)

The server has infrastructure for MCP Apps (tools paired with an interactive HTML UI resource rendered inside the client) via `app/mcp/apps/get-time-app.ts`, but `registerGetTimeApp` is **not currently wired into `registerAllTools`** — it exists as a reference implementation, not an active feature.

## Local development

```bash
pnpm install
pnpm dev              # Next.js dev server on http://localhost:3000
```

With `pnpm dev` running, `.mcp.json` registers an HTTP MCP connection (`mcp-utilities-local`) to `http://localhost:3000/mcp`, exposing the real tools prefixed `mcp-utilities-local__` for local testing. A separate `claude.ai MCP` connection points at the deployed instance and reflects whatever is currently shipped, not local edits.

```bash
pnpm build
pnpm type-check       # tsc --noEmit
pnpm lint             # eslint
```

There is no test framework in this repo — `pnpm type-check` and `pnpm lint` are the only automated checks.

## Environment variables

Required in `.env.local` (gitignored): `UPSTASH_VECTOR_REST_URL`/`_TOKEN`, `NEO4J_URI`/`_USERNAME`/`_PASSWORD`/`_DATABASE`, `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `AI_GATEWAY_API_KEY`.

`GOOGLE_GENERATIVE_AI_API_KEY` is optional: setting it routes only the multimodal figure embedding through `@ai-sdk/google` directly instead of the gateway (see [lib/embedding.ts](lib/embedding.ts)). Leave it unset unless `pnpm verify:multimodal` says the gateway is dropping the image.

## Provisioning done by hand

Nothing in this repo creates schema. Four things must already exist in the provisioned services, and each fails differently if it does not:

| What | Created by | Symptom if missing |
| --- | --- | --- |
| Neon `uploads` table | manually | ingestion fails at `recordUpload`, the last step, after all the model spend |
| Neo4j `entity_names` vector index | manually | `search_graph` returns nothing, with no error |
| Neon `document_requests` table | **[db/document_requests.sql](db/document_requests.sql)** | the review queue reads empty with a notice; `request_document` refuses and says which file to run |
| Neon `ingestion_runs` table | **[db/ingestion_runs.sql](db/ingestion_runs.sql)** | ingestion still works, but an interrupted one cannot be found again — the unfinished list reads empty with a notice, and recovery falls back to the Blob scan |

`document_requests` is the easy one to miss, because the failure surfaces at the far end of the system — inside an MCP tool call from a model, rather than anywhere near the database. Run it once and the queue works.

`ingestion_runs` fails quietly by design. Everything that touches it degrades rather than aborts: the upload route logs and starts the run anyway, `markResumePoint` treats a missing table as the one error not worth retrying, and both read paths return empty with the file to run. Losing the ability to recover an ingestion is bad; refusing to ingest at all because the recovery table is absent would be worse.
