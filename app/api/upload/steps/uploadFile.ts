import { v4 as uuidv4 } from "uuid";
import { put } from "@vercel/blob";

// ---------------------------------------------------------------------------
// Blob writes made by the pipeline itself.
//
// There is no uploadPdf step: the browser uploads the PDF straight to Blob
// before the workflow starts (see .claude/conventions/file-uploads.md), so by
// the time ingestPdf runs the document is already stored.
// ---------------------------------------------------------------------------

// Persists the converted Markdown so re-embedding — and retrying a failed
// ingestion — can skip the Gemini PDF→Markdown step entirely instead of
// re-running it on every attempt.
export async function uploadMarkdown(fileName: string, markdown: string): Promise<string> {
  "use step";

  const blob = await put(`markdown/${uuidv4()}-${fileName}.md`, markdown, {
    access: "public",
    addRandomSuffix: false,
    contentType: "text/markdown",
  });

  return blob.url;
}
