
import { vectorIndex } from "@/lib/vector";
// ---------------------------------------------------------------------------
// Step 3: Chunk, embed, and upsert to Upstash Vector
// ---------------------------------------------------------------------------

import { embedMany } from "ai";
import { BlobInfo } from "./recordUpload";
import { chunkId, chunkText, extractTitle } from "@/lib/chunking";
import { sparseVector } from "@/lib/sparse";

export async function createEmbeddings(fileName: string, blob: BlobInfo, markdown: string) {
  "use step";

  const title = extractTitle(markdown, fileName);
  const chunks = chunkText(markdown);

  const { embeddings } = await embedMany({
    model: "google/gemini-embedding-2",
    values: chunks.map((chunk) => `title: ${title} | text: ${chunk}`),
    providerOptions: {
      google: { outputDimensionality: 1536, taskType: "RETRIEVAL_DOCUMENT" },
    },
  });

  await vectorIndex.upsert(
    embeddings.map((embedding, i) => ({
      id: chunkId(fileName, i),
      vector: embedding,
      sparseVector: sparseVector(chunks[i]),
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
