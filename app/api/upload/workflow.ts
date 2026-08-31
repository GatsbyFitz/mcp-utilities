import { IngestInput, recordUpload } from "./steps/recordUpload";
import { uploadMarkdown } from "./steps/uploadFile";
import { createMarkdown, fetchMarkdown } from "./steps/pdfReader";
import { contextualizeChunks } from "./steps/contextualizeChunks";
import { createEmbeddings } from "./steps/createEmbeddings";
import { extractGraph } from "./steps/extractGraph";
import { markResumePoint, type ResumePoint } from "./steps/resumePoint";

export async function ingestPdf(input: IngestInput) {
  "use workflow";

  // No upload step: the browser put the PDF in Blob before this run started.
  const blob = input.blob;
  const markdown = await createMarkdown(blob.url);

  // Persisted so a future re-embed can skip the Gemini PDF→Markdown step
  // entirely instead of re-parsing the PDF from scratch every time.
  const markdownUrl = await uploadMarkdown(input.fileName, markdown);

  // Everything a retry needs, written to the journal before the steps that
  // actually tend to fail. See resumeIngest below.
  await markResumePoint(input.fileName, input.sizeBytes, blob, markdownUrl);

  const chunkContexts = await contextualizeChunks(input.fileName, markdown);
  const { chunkCount, title } = await createEmbeddings(input.fileName, blob, markdown, chunkContexts);

  // Separate step from createEmbeddings: extraction is the expensive, flaky
  // part, and a retry here shouldn't re-embed every chunk. It re-derives
  // chunks from the markdown rather than receiving them, so the workflow
  // doesn't have to durably persist the whole document twice.
  const { entityCount, relationCount } = await extractGraph(input.fileName, markdown);

  await recordUpload(input.fileName, input.sizeBytes, blob, chunkCount, markdownUrl);

  return {
    fileName: input.fileName,
    chunks: chunkCount,
    title,
    entities: entityCount,
    relations: relationCount,
  };
}

/**
 * Retry of a failed `ingestPdf`, picking up from the markdown that run already
 * persisted. A failed run is terminal — the runtime cannot resume it in place
 * (re-enqueueing a failed run is a no-op), so this is a fresh run that simply
 * starts past the work that already succeeded: the PDF is not re-uploaded and,
 * crucially, the Gemini PDF→Markdown parse never runs again.
 *
 * The tail is deliberately identical to `ingestPdf`'s and to
 * `reembedDocument`'s — the same steps in the same order, so chunk boundaries
 * and IDs stay in sync between Upstash and Neo4j (see the chunking invariant
 * in CLAUDE.md). Keep all three in step if any of them changes.
 */
export async function resumeIngest(resume: ResumePoint) {
  "use workflow";

  const markdown = await fetchMarkdown(resume.markdownUrl);

  const chunkContexts = await contextualizeChunks(resume.fileName, markdown);
  const { chunkCount, title } = await createEmbeddings(
    resume.fileName,
    resume.blob,
    markdown,
    chunkContexts
  );

  const { entityCount, relationCount } = await extractGraph(resume.fileName, markdown);

  await recordUpload(
    resume.fileName,
    resume.sizeBytes,
    resume.blob,
    chunkCount,
    resume.markdownUrl
  );

  return {
    fileName: resume.fileName,
    chunks: chunkCount,
    title,
    entities: entityCount,
    relations: relationCount,
  };
}
