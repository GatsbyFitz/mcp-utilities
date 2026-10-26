# File uploads

**File bytes never pass through a route handler.** A Vercel function caps its
request body at 4.5 MB and returns `413 FUNCTION_PAYLOAD_TOO_LARGE` above that,
rejected at the platform edge before any handler code runs. The limit is not
configurable. Regulatory PDFs exceed it routinely, so every client upload goes
straight to Blob storage instead.

## The pattern

Three pieces, all of which already exist for PDFs — copy them for any new
upload surface rather than accepting a form body:

1. **Browser** — `upload()` from `@vercel/blob/client` with `multipart: true`
   (Blob handles up to 5 TB, uploading parts in parallel and retrying failures),
   `handleUploadUrl` pointing at a token route, and `onUploadProgress` for a
   progress bar. Pass the original file name in `clientPayload`.
2. **Token route** — `handleUpload()` from `@vercel/blob/client`, auth-gated
   with `getToken`. This is where an upload is authorised, so it is where an
   upload is *refused*: check duplicates and set `allowedContentTypes` /
   `maximumSizeInBytes` in `onBeforeGenerateToken`, so a rejected file never
   transfers a byte. The returned client token carries those constraints — they
   are enforced by Blob, not by the browser.
3. **Ingest route** — receives a small JSON manifest of finished uploads
   (`UploadedFile[]` from [lib/upload.ts](../../lib/upload.ts)) and starts work.
   It re-checks anything the token route checked: that route is a convenience
   for the browser, not a guarantee, and a client can skip it.

Shared constants, the name-normalisation rule, and the manifest type live in
[lib/upload.ts](../../lib/upload.ts) so client and server cannot disagree.

## A second surface: the AER schedule workbooks

`POST /api/ingestSchedule` and `/api/ingestSchedule/token` are that pattern
copied, not the PDF routes widened. The two authorise different things, and the
difference is the point: the PDF token route refuses a duplicate document name,
which is right for the knowledge base — chunk ids are built from it — and wrong
for a quarter that may legitimately be re-uploaded to correct it. So
`ALLOWED_UPLOAD_CONTENT_TYPES` and `ALLOWED_SPREADSHEET_CONTENT_TYPES` are
separate lists and each caller names the one it means. Widening the PDF list
instead would let a workbook through the token route and then fail it deep
inside `createMarkdown`, with an error about Markdown rather than about the
file being a spreadsheet.

## A third way in: `submit_schedule`, and the one credential on `/mcp`

`submit_schedule` is an MCP tool that takes an AER workbook URL, a schedule number and a period label. It is the only tool on the public `/mcp` endpoint that will fetch a supplied URL from inside the deployment and start a run, which is exactly what `request_document` refuses to do — that tool stores a URL as a suggestion precisely so an unauthenticated caller cannot use this server as a proxy into its own network.

What makes the difference is `MCP_INGEST_SECRET` ([lib/ingestSecret.ts](../../lib/ingestSecret.ts)), and it has three outcomes rather than two:

| Secret | What happens |
| --- | --- |
| none offered | a pending row in `schedule_requests`. Nothing fetched. The `request_document` contract. |
| offered and accepted | `downloadToBlob` + `start(ingestSchedule, …)`, same as an operator using the page. |
| offered and refused | nothing ingested **and nothing queued** |

That third row is the one worth keeping. A wrong secret quietly becoming a queued request would have the caller report the quarter as loaded, with a row in a review queue as the only evidence against it — so a rejected credential says so and writes nothing.

**It is not `APP_PASSWORD`.** An MCP tool argument travels through model context, client transcripts and whatever host relays the call; a credential that also grants the whole signed-in UI does not belong in that path. A scoped secret limits what a leak costs to "someone can queue an AER workbook" and can be rotated without locking anyone out.

**Unset means refuse.** With no secret configured, every value is rejected and only the queue path works. That is the opposite of how `anthropicByok` degrades a few files away, deliberately: a missing *billing* credential is not a reason to stop ingesting a document, and a missing *authorisation* credential is not a reason to start one. `pnpm verify:ingest-secret` pins it.

The queue is resolved by `POST /api/scheduleRequests`, which is where a queued URL is finally fetched — the same shape as `documentRequests`, and the same reason: approval by a signed-in human is the event that makes a model-supplied URL safe to fetch. The operator can correct the schedule and period on approval, because those two fields are the workbook's identity and a quarter stored under the wrong label is wrong in a way no later query can detect.

## Fetching by URL is the same fetcher

A document the server fetches itself — an approved `request_document`, or an
AER workbook linked from a release page — goes through `downloadToBlob` in
[lib/fetchDocument.ts](../../lib/fetchDocument.ts), parameterised by a
`DocumentKind` rather than copied. That file resolves the hostname and checks
the *resolved* addresses on every redirect hop, because a server-side fetch of
a supplied URL leaves from inside the deployment, where it can reach metadata
endpoints and anything else not exposed to the internet. A second fetcher would
lose all of that while looking like it worked. Add a kind; never a fetcher.

## Do not use `onUploadCompleted`

It is a Blob-to-server callback that cannot reach `localhost`, so depending on
it to kick off work means local development needs a tunnel. The browser POSTs
the manifest to the ingest route once its uploads finish instead.

## Server-side `put()` is still fine

The rule is about bytes arriving *from a client*. Content the server generates
itself — `uploadMarkdown` writing converted Markdown — writes to Blob directly
with `put()` and is unaffected by the request-body limit.

## Consequences for the workflow

Because the PDF is already stored before ingestion starts, `ingestPdf` takes a
`BlobInfo` rather than a `Uint8Array` and there is no upload step: the pipeline
begins at `createMarkdown`. This also keeps the document out of the workflow
journal, which would otherwise persist every uploaded PDF a second time.
