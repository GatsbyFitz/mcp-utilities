import { embedMany } from "ai";
import { vectorIndex, escapeFilterValue } from "@/lib/vector";
import { sparseVector } from "@/lib/sparse";
import { documentCitationMeta } from "@/lib/documentMeta";
import { extractTitle } from "@/lib/chunking";
import { FIGURE_KIND, figureId, type ExtractedFigure } from "@/lib/figures";
import type { BlobInfo } from "./recordUpload";

// ---------------------------------------------------------------------------
// Step: embed each figure from its description *and* its pixels
// ---------------------------------------------------------------------------
// `gemini-embedding-2` accepts multimodal input through
// providerOptions.google.content — an array of parts per value, each part
// text, inlineData or fileData. That is what makes this cheap: the figure
// vector lands in the same model, the same 1536 dimensions and the same space
// as every text chunk, so there is no second index, no second credential, and
// nothing on the query side to change. search_docs already embeds its query
// with this model, so a figure is directly comparable to a text chunk.
//
// inlineData rather than fileData: `fileUri` expects a Files API or GCS URI,
// not an arbitrary public Blob URL.

export async function embedFigures(
  fileName: string,
  blob: BlobInfo,
  markdown: string,
  figures: ExtractedFigure[]
): Promise<{ figureCount: number }> {
  "use step";

  // Always clear first, even with nothing to add: a re-run that finds fewer
  // figures than last time must not leave the surplus behind, and upsert alone
  // would. Scoped by `kind` so text chunks are untouched.
  await vectorIndex.delete({
    filter: `source = '${escapeFilterValue(fileName)}' AND kind = '${FIGURE_KIND}'`,
  });

  if (figures.length === 0) return { figureCount: 0 };

  const title = extractTitle(markdown, fileName);
  const { version, publisher } = documentCitationMeta(fileName);

  const { embeddings } = await embedMany({
    model: "google/gemini-embedding-2",
    // `content` supersedes these, but they are kept populated deliberately:
    // if the option is ever dropped in transit, the vector degrades to a
    // description-only embedding rather than to nothing. Same
    // `title: … | text: …` prefix convention as createEmbeddings.
    values: figures.map((f) => `title: ${title} | text: ${f.description}`),
    providerOptions: {
      google: {
        outputDimensionality: 1536,
        taskType: "RETRIEVAL_DOCUMENT",
        content: figures.map((f) => [
          { text: `title: ${title} | figure: ${f.description}` },
          { inlineData: { mimeType: "image/png", data: f.pngBase64 } },
        ]),
      },
    },
  });

  await vectorIndex.upsert(
    embeddings.map((embedding, i) => ({
      id: figureId(fileName, i),
      vector: embedding,
      // Sparse side stays text-only — the description is all there is to
      // tokenize, and it keeps figures in the same hybrid search as chunks.
      sparseVector: sparseVector(figures[i].description),
      metadata: {
        // Mirrors a text chunk's shape so toCitation needs no special case.
        text: figures[i].description,
        title,
        source: fileName,
        blobUrl: blob.url,
        blobDownloadUrl: blob.downloadUrl,
        blobPath: blob.pathname,
        pageStart: figures[i].page,
        pageEnd: figures[i].page,
        version,
        publisher,
        // The two fields that make it a figure.
        kind: FIGURE_KIND,
        imageUrl: figures[i].imageUrl,
      },
    }))
  );

  return { figureCount: figures.length };
}
