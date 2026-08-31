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
