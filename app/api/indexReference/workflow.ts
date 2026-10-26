import {
  embedReferenceDescriptor,
  recordReference,
  storeReferenceVector,
  type ReferenceInput,
} from "../upload/steps/referenceIndex";

/**
 * Register one reference page: the row, its descriptor's embedding, the vector.
 *
 * A workflow rather than three inline awaits so the run is durable, each step
 * retries on its own, and the upload page can show it moving — the same
 * progress card every other pipeline here reports through.
 *
 * The trade is that `add_reference` returns before the reference is
 * searchable. It is queued, not indexed, and the tool says so: claiming
 * otherwise would have a model add a page and immediately fail to find it.
 * The gap is seconds, and `indexed_at` is what settles the question either way.
 *
 * Validation does **not** live here. A bad URL or a missing summary is a typo
 * to refuse at the door, not a run to start and fail one step later — the same
 * reasoning as the period check in `POST /api/ingestSchedule`.
 */
export async function indexReferencePage(input: ReferenceInput) {
  "use workflow";

  await recordReference(input);
  const embedding = await embedReferenceDescriptor(input);
  await storeReferenceVector(input, embedding);

  return { name: input.name, url: input.url, title: input.title };
}
