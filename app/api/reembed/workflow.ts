import { BlobInfo, updateUploadAfterReembed } from "../upload/steps/recordUpload";
import { uploadMarkdown } from "../upload/steps/uploadFile";
import { createMarkdown, fetchMarkdown } from "../upload/steps/pdfReader";
import { contextualizeChunks } from "../upload/steps/contextualizeChunks";
import { createEmbeddings } from "../upload/steps/createEmbeddings";
import { extractGraph } from "../upload/steps/extractGraph";

export interface ReembedInput {
  id: string;
  fileName: string;
  blobUrl: string;
  blobDownloadUrl: string;
  blobPath: string;
  markdownUrl: string | null;
}

export async function reembedDocument(input: ReembedInput) {
  "use workflow";

  const blob: BlobInfo = {
    url: input.blobUrl,
    downloadUrl: input.blobDownloadUrl,
    pathname: input.blobPath,
  };

  // Prefer the persisted markdown so re-embedding never re-runs the Gemini
  // PDF→Markdown step. Legacy rows uploaded before markdown_url existed fall
  // back to regenerating it once, then self-heal by persisting it for next time.
  const markdown = input.markdownUrl
    ? await fetchMarkdown(input.markdownUrl)
    : await createMarkdown(input.blobUrl);
  const markdownUrl = input.markdownUrl ?? (await uploadMarkdown(input.fileName, markdown));

  const chunkContexts = await contextualizeChunks(input.fileName, markdown);
  const { chunkCount, title } = await createEmbeddings(input.fileName, blob, markdown, chunkContexts);

  // Re-extracting the graph from the same markdown keeps chunkId boundaries
  // in sync between Upstash and Neo4j — see the chunking invariant in CLAUDE.md.
  const { entityCount, relationCount } = await extractGraph(input.fileName, markdown);

  await updateUploadAfterReembed(input.id, chunkCount, markdownUrl);

  return {
    fileName: input.fileName,
    chunks: chunkCount,
    title,
    entities: entityCount,
    relations: relationCount,
  };
}
