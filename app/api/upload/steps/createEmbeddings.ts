
import { vectorIndex } from "@/lib/vector";
// ---------------------------------------------------------------------------
// Step 3: Chunk, embed, and upsert to Upstash Vector
// ---------------------------------------------------------------------------

import { embedMany } from "ai";
import { BlobInfo } from "./recordUpload";
import { chunkId, chunkText, extractTitle } from "@/lib/chunking";
import { sparseVector } from "@/lib/sparse";

export async function createEmbeddings(
  fileName: string,
  blob: BlobInfo,
  markdown: string,
  chunkContexts: string[]
) {
  "use step";

  const title = extractTitle(markdown, fileName);
  const chunks = chunkText(markdown);

  // Contextual retrieval: the situating blurb is folded into what gets
  // embedded (dense) and sparsified, but never into metadata.text — that's
  // the original excerpt shown for citations and fetched by search_graph.
  const contextualized = chunks.map((chunk, i) => {
    const context = chunkContexts[i];
    return context ? `${context}\n${chunk}` : chunk;
  });

  const { embeddings } = await embedMany({
    model: "google/gemini-embedding-2",
    values: contextualized.map((text) => `title: ${title} | text: ${text}`),
    providerOptions: {
      google: { outputDimensionality: 1536, taskType: "RETRIEVAL_DOCUMENT" },
    },
  });

  await vectorIndex.upsert(
    embeddings.map((embedding, i) => ({
      id: chunkId(fileName, i),
      vector: embedding,
      sparseVector: sparseVector(contextualized[i]),
      metadata: {
        text: chunks[i],
        title,
        source: fileName,
        chunkIndex: i,
        blobUrl: blob.url,
        blobDownloadUrl: blob.downloadUrl,
        blobPath: blob.pathname,
      },
    }))
  );

  return { chunkCount: chunks.length, title };
}
