
import { vectorIndex } from "@/lib/vector";
// ---------------------------------------------------------------------------
// Step 3: Chunk, embed, and upsert to Upstash Vector
// ---------------------------------------------------------------------------

import { embedMany } from "ai";
import { BlobInfo } from "./recordUpload";

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
      id: `${fileName}-${i}`,
      vector: embedding,
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


function extractTitle(markdown: string, filename: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : titleFromFilename(filename);
}

function chunkText(text: string, size = 500): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(" "));
  }
  return chunks;
}

function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.(pdf|docx?|txt|md)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}