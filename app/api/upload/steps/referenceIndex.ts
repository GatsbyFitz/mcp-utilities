import { embed } from "ai";
import { vectorIndex } from "@/lib/vector";
import { sparseVector } from "@/lib/sparse";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import { REFERENCE_KIND, descriptorText, referenceId } from "@/lib/references";
import { markReferenceIndexed, upsertReference } from "@/lib/referenceStore";

// ---------------------------------------------------------------------------
// Steps: register one reference page
// ---------------------------------------------------------------------------
// Here with the other steps rather than beside its workflow, because this is
// where `withWorkflow()` finds them and where anyone looking for a step looks.
// It is not part of the upload pipeline despite the directory.
//
// Three steps, for the reason the workflow-steps rule gives: step boundaries
// are cost boundaries, and the embedding is the only call that leaves the
// deployment. A failed vector write must not re-pay for it.
//
// The order is row, then vector, then timestamp, and it is load-bearing. If
// the embedding fails the row survives as unindexed — visible on the page and
// re-runnable — whereas writing the vector first would leave a descriptor in
// the index pointing at a reference the table does not have. `indexed_at` is
// the honest record of whether a reference is findable, not of whether
// something tried.

export interface ReferenceInput {
  name: string;
  url: string;
  title: string;
  summary: string;
  keyTerms: string[];
}

/** Step 1: the row. Written first so a later failure is visible, not lost. */
export async function recordReference(input: ReferenceInput): Promise<void> {
  "use step";
  await upsertReference(input);
}

/**
 * Step 2: the descriptor's embedding — the only call that costs anything.
 *
 * Returns the vector rather than writing it, so the write can retry without
 * re-embedding. 1536 floats is small enough to sit in the journal; the
 * workbook-sized payloads this rule usually guards against are elsewhere.
 */
export async function embedReferenceDescriptor(input: ReferenceInput): Promise<number[]> {
  "use step";

  const { embedding } = await embed({
    model: EMBEDDING_MODEL,
    value: `title: ${input.title} | text: ${descriptorText(input)}`,
    providerOptions: {
      google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: "RETRIEVAL_DOCUMENT" },
    },
  });
  return embedding;
}

/**
 * Step 3: the vector, then the timestamp.
 *
 * Both here so `indexed_at` cannot be set by a run whose vector write failed —
 * a row claiming to be findable when it is not is the one state the page
 * cannot show you.
 */
export async function storeReferenceVector(
  input: ReferenceInput,
  embedding: number[]
): Promise<void> {
  "use step";

  const text = descriptorText(input);

  await vectorIndex.upsert([
    {
      id: referenceId(input.name),
      vector: embedding,
      // The index is hybrid: a dense-only upsert is rejected outright and
      // nothing is written. Unprefixed text, as every other writer uses.
      sparseVector: sparseVector(text),
      metadata: {
        // Mirrors a chunk's shape so a citation needs no special case, even
        // though a reference carries no page.
        text: input.summary,
        title: input.title,
        source: input.name,
        blobUrl: input.url,
        pageStart: null,
        pageEnd: null,
        kind: REFERENCE_KIND,
        url: input.url,
        keyTerms: input.keyTerms,
      },
    },
  ]);

  await markReferenceIndexed(input.name);
}
