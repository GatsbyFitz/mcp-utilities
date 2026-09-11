import { embedMany } from "ai";
import type { GoogleEmbeddingModelOptions } from "@ai-sdk/google";
import { vectorIndex, escapeFilterValue } from "@/lib/vector";
import { sparseVector } from "@/lib/sparse";
import { documentCitationMeta } from "@/lib/documentMeta";
import { extractTitle } from "@/lib/chunking";
import { EMBEDDING_DIMENSIONS, multimodalEmbeddingModel } from "@/lib/embedding";
import {
  FIGURE_KIND,
  MAX_FIGURES_PER_EMBED_REQUEST,
  figureId,
  type ExtractedFigure,
} from "@/lib/figures";
import type { BlobInfo } from "./recordUpload";

// ---------------------------------------------------------------------------
// Step: embed each figure from its description *and* its pixels
// ---------------------------------------------------------------------------
// `gemini-embedding-2` is natively multimodal: providerOptions.google.content
// takes an array of parts per value, and the parts of one entry are aggregated
// into a single vector. So `[{ text }, { inlineData }]` produces one embedding
// per figure covering both its description and its image.
//
// That vector lands in the same model, the same dimensionality and the same
// space as every text chunk, which is why there is no second index, no second
// credential and nothing to change on the query side — search_docs already
// embeds its query with this model.
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
  const model = multimodalEmbeddingModel();

  // One request per batch. `embedMany` puts every value in a single HTTP
  // request no matter how many images they carry, so without this a document
  // with more than six figures exceeds the API's image limit and the whole
  // request is rejected — the batching has to happen here.
  const embedded: { figure: ExtractedFigure; vector: number[] }[] = [];

  for (let start = 0; start < figures.length; start += MAX_FIGURES_PER_EMBED_REQUEST) {
    // `values` and `content` are positionally paired and must stay the same
    // length, so they are sliced together from one batch rather than derived
    // separately — misaligning them would attach every vector to the wrong
    // figure's metadata, silently.
    const batch = figures.slice(start, start + MAX_FIGURES_PER_EMBED_REQUEST);

    try {
      const { embeddings } = await embedMany({
        model,
        // `content` supersedes these, but they are kept populated deliberately:
        // if the option is ever dropped in transit the vector degrades to a
        // description-only embedding rather than to nothing. Same
        // `title: … | text: …` prefix convention as createEmbeddings.
        values: batch.map((f) => `title: ${title} | text: ${f.description}`),
        providerOptions: {
          google: {
            outputDimensionality: EMBEDDING_DIMENSIONS,
            taskType: "RETRIEVAL_DOCUMENT",
            content: batch.map((f) => [
              { text: `title: ${title} | figure: ${f.description}` },
              { inlineData: { mimeType: "image/png", data: f.embedPngBase64 } },
            ]),
            // Types `content` at compile time — providerOptions is otherwise
            // loose enough that a malformed shape would only fail in flight.
          } satisfies GoogleEmbeddingModelOptions,
        },
      });

      batch.forEach((figure, i) => embedded.push({ figure, vector: embeddings[i] }));
    } catch (error) {
      // Degrade, never abort: the document has already paid for its parse,
      // chunks and graph by now, and one rejected batch must not cost all of
      // it. The figures in this batch are simply not indexed.
      console.warn(
        `[embedFigures] ${fileName}: batch ${start / MAX_FIGURES_PER_EMBED_REQUEST + 1} failed, skipping`,
        error
      );
    }
  }

  if (embedded.length === 0) return { figureCount: 0 };

  await vectorIndex.upsert(
    embedded.map(({ figure, vector }, i) => ({
      id: figureId(fileName, i),
      vector,
      // Sparse side stays text-only — the description is all there is to
      // tokenize, and it keeps figures in the same hybrid search as chunks.
      sparseVector: sparseVector(figure.description),
      metadata: {
        // Mirrors a text chunk's shape so toCitation needs no special case.
        text: figure.description,
        title,
        source: fileName,
        blobUrl: blob.url,
        blobDownloadUrl: blob.downloadUrl,
        blobPath: blob.pathname,
        pageStart: figure.page,
        pageEnd: figure.page,
        version,
        publisher,
        // The two fields that make it a figure.
        kind: FIGURE_KIND,
        imageUrl: figure.imageUrl,
        inlineImageUrl: figure.inlineImageUrl,
      },
    }))
  );

  return { figureCount: embedded.length };
}
