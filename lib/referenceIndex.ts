import { embed } from "ai";
import { vectorIndex } from "@/lib/vector";
import { sparseVector } from "@/lib/sparse";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import { REFERENCE_KIND, descriptorText, referenceId } from "@/lib/references";
import { markReferenceIndexed, upsertReference } from "@/lib/referenceStore";

// ---------------------------------------------------------------------------
// Writing one reference into both stores
// ---------------------------------------------------------------------------
// Shared by the authenticated route and the `add_reference` MCP tool, so a
// reference added by a person and one added by a model land in exactly the
// same state. A second copy of this would be a second chance to forget the
// sparse vector, which the hybrid index rejects outright.

export interface ReferenceInput {
  name: string;
  url: string;
  title: string;
  summary: string;
  keyTerms: string[];
}

/**
 * Row, then vector, then timestamp.
 *
 * That order matters. If the embedding fails the row survives as unindexed —
 * visible on the page and re-runnable — whereas writing the vector first would
 * leave a descriptor in the index pointing at a reference the table does not
 * have. `indexed_at` is therefore the honest record of whether a reference is
 * findable, not of whether someone tried.
 */
export async function indexReference(source: ReferenceInput): Promise<void> {
  const { name, url, title, summary, keyTerms } = source;
  await upsertReference(source);

  const text = descriptorText({ title, summary, keyTerms });
  const { embedding } = await embed({
    model: EMBEDDING_MODEL,
    value: `title: ${title} | text: ${text}`,
    providerOptions: {
      google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: "RETRIEVAL_DOCUMENT" },
    },
  });

  await vectorIndex.upsert([
    {
      id: referenceId(name),
      vector: embedding,
      // The index is hybrid: a dense-only upsert is rejected outright and
      // nothing is written. Unprefixed text, as every other writer uses.
      sparseVector: sparseVector(text),
      metadata: {
        // Mirrors a chunk's shape so a citation needs no special case, even
        // though a reference carries no page.
        text: summary,
        title,
        source: name,
        blobUrl: url,
        pageStart: null,
        pageEnd: null,
        kind: REFERENCE_KIND,
        url,
        keyTerms,
      },
    },
  ]);

  await markReferenceIndexed(name);
}
