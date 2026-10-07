import { extractProcesses, readFigureSources } from "../upload/steps/extractProcesses";
import type { BlobInfo } from "../upload/steps/recordUpload";

export interface ReextractProcessesInput {
  fileName: string;
  blobUrl: string;
  blobDownloadUrl: string;
  blobPath: string;
}

/**
 * Read the processes out of one document's existing figures, and nothing else.
 *
 * Deliberately the cheapest workflow here. `reextractFigures` has to fetch the
 * PDF and render pages; this does neither, because the figures are already in
 * the index with the image URL, page and description each one needs. So it
 * reaches every document that already has figures without re-ingesting any of
 * them, and it is the affordable way to iterate on the Mermaid prompt — which
 * will need iterating.
 *
 * The blob fields are carried only so a process cites the same document its
 * figures do; no PDF byte is read.
 */
export async function reextractProcesses(input: ReextractProcessesInput) {
  "use workflow";

  const blob: BlobInfo = {
    url: input.blobUrl,
    downloadUrl: input.blobDownloadUrl,
    pathname: input.blobPath,
  };

  const sources = await readFigureSources(input.fileName);

  // Null markdown: the title falls back to the file name rather than paying a
  // blob fetch, or worse a Gemini parse, for one string.
  const processReport = await extractProcesses(input.fileName, blob, null, sources);

  return {
    fileName: input.fileName,
    figures: sources.length,
    processes: processReport.processCount,
    processReport,
  };
}
