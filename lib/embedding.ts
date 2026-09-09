import { google } from "@ai-sdk/google";

// ---------------------------------------------------------------------------
// One definition of the embedding model, shared by every side of retrieval.
//
// Document chunks, figures, entity names and both query paths must all embed
// with the same model at the same dimensionality, or vectors from one are
// being compared against vectors from another and retrieval degrades with no
// error anywhere. The Upstash index and the Neo4j `entity_names` index are
// both provisioned at these dimensions, so changing them is a re-index, not a
// config tweak.
// ---------------------------------------------------------------------------

/**
 * Routed through AI Gateway, like every other model in this repo, so spend and
 * traces stay in one place.
 *
 * Note this is `gemini-embedding-2`, not `gemini-embedding-2-preview` — the
 * provider's multimodal example uses the preview id, and copying it here would
 * put figures in a different space from the text chunks they are ranked
 * against.
 */
export const EMBEDDING_MODEL = "google/gemini-embedding-2";

/** Must match the Upstash index and the Neo4j `entity_names` index. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * The model to use for embeddings that carry an image.
 *
 * Defaults to the gateway like everything else. The provider's own multimodal
 * example calls `google.embedding(...)` directly, and it is not confirmed that
 * the gateway relays `providerOptions.google.content` — if it does not, the
 * call still succeeds and still returns a vector, just one that never saw the
 * image (see scripts/verify-multimodal-embedding.mjs).
 *
 * Setting GOOGLE_GENERATIVE_AI_API_KEY switches this one call to the direct
 * provider, which removes that hop entirely. It is a remedy to reach for if
 * the verification script reports the option is being dropped — not something
 * to set speculatively, since it moves this spend off the gateway.
 */
export function multimodalEmbeddingModel() {
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY
    ? google.embedding(EMBEDDING_MODEL.replace(/^google\//, ""))
    : EMBEDDING_MODEL;
}
