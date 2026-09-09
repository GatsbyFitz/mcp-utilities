import { recordMarkdownUrl, type BlobInfo } from "../upload/steps/recordUpload";
import { uploadMarkdown } from "../upload/steps/uploadFile";
import { createMarkdown, fetchMarkdown } from "../upload/steps/pdfReader";
import { extractFigures } from "../upload/steps/extractFigures";
import { embedFigures } from "../upload/steps/embedFigures";

export interface ReextractFiguresInput {
  id: string;
  fileName: string;
  blobUrl: string;
  blobDownloadUrl: string;
  blobPath: string;
  markdownUrl: string | null;
}

/**
 * Add (or rebuild) one document's figures, and nothing else.
 *
 * This is what lets the feature reach documents that were ingested before it
 * existed without re-ingesting them. Figures occupy their own vector-ID
 * namespace, so running this touches no text chunk, no chunk ID, and none of
 * the `chunkId`s that Neo4j relationships point at — unlike a change to
 * `chunkText`, which would.
 *
 * Also the cheap way to iterate on the figure prompt: re-running costs the
 * page renders and one vision call per figure-bearing page, not a re-embed of
 * the whole document.
 */
export async function reextractFigures(input: ReextractFiguresInput) {
  "use workflow";

  const blob: BlobInfo = {
    url: input.blobUrl,
    downloadUrl: input.blobDownloadUrl,
    pathname: input.blobPath,
  };

  // Prefer the persisted Markdown: it carries the `[Figure: ...]` and page
  // markers this needs, and reusing it skips the Gemini PDF→Markdown parse.
  // A legacy row without one regenerates it and then self-heals.
  const markdown = input.markdownUrl
    ? await fetchMarkdown(input.markdownUrl)
    : await createMarkdown(input.blobUrl);

  if (!input.markdownUrl) {
    const markdownUrl = await uploadMarkdown(input.fileName, markdown);
    await recordMarkdownUrl(input.id, markdownUrl);
  }

  const figures = await extractFigures(input.fileName, blob.url, markdown);
  const { figureCount } = await embedFigures(input.fileName, blob, markdown, figures);

  return { fileName: input.fileName, figures: figureCount };
}
