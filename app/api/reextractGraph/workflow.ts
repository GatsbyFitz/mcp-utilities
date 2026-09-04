import { recordMarkdownUrl } from "../upload/steps/recordUpload";
import { uploadMarkdown } from "../upload/steps/uploadFile";
import { createMarkdown, fetchMarkdown } from "../upload/steps/pdfReader";
import { extractGraph } from "../upload/steps/extractGraph";

export interface ReextractGraphInput {
  id: string;
  fileName: string;
  blobUrl: string;
  markdownUrl: string | null;
}

/**
 * Rebuild one document's graph and nothing else.
 *
 * `reembedDocument` re-extracts the graph too, but only after paying for
 * `contextualizeChunks` and `createEmbeddings` — one model call per chunk plus
 * a full re-embed — which is wasted whenever the vectors are already correct
 * and it is the extraction that changed (a new prompt, a constrained
 * relationship vocabulary, a model swap).
 *
 * This is safe to run alone because `extractGraph` takes the markdown, not the
 * contextualised chunks: nothing it produces depends on the embedding pass.
 *
 * It does depend on the chunking invariant. `extractGraph` re-derives chunks
 * with `chunkText` and stores a `chunkId` on every relationship, which
 * `search_graph` feeds straight to `vectorIndex.fetch()`. Same markdown and
 * same `chunkText` gives byte-identical IDs, so the edges keep resolving. If
 * [lib/chunking.ts](../../../lib/chunking.ts) has changed since the document
 * was embedded, this alone is not enough — the new IDs will not exist in
 * Upstash, and every graph hit will return a missing excerpt. Re-embed then,
 * so both sides are rebuilt from the same rules.
 */
export async function reextractGraph(input: ReextractGraphInput) {
  "use workflow";

  // Prefer the persisted markdown so this never re-runs the Gemini PDF→Markdown
  // step. A legacy row without one regenerates it once and then self-heals.
  const markdown = input.markdownUrl
    ? await fetchMarkdown(input.markdownUrl)
    : await createMarkdown(input.blobUrl);

  if (!input.markdownUrl) {
    const markdownUrl = await uploadMarkdown(input.fileName, markdown);
    await recordMarkdownUrl(input.id, markdownUrl);
  }

  // Idempotent per document: replaceDocumentGraph deletes this document's
  // edges, MERGEs entities, recreates the edges, then prunes orphans. Nothing
  // else in the graph is touched.
  const { entityCount, relationCount } = await extractGraph(input.fileName, markdown);

  return {
    fileName: input.fileName,
    entities: entityCount,
    relations: relationCount,
  };
}
