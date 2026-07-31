// Single source of truth for sparse (BM25-style) vectors. createEmbeddings
// (document side) and search_docs (query side) must tokenize identically or
// term overlap between a query and a chunk silently stops matching.

const VOCAB_SIZE = 262144; // 2^18 hashing-trick buckets

function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface SparseVector {
  indices: number[];
  values: number[];
}

/**
 * Term-frequency sparse vector via the hashing trick: tokens hash into a
 * fixed-width bucket space instead of requiring a persisted vocabulary.
 * Upstash applies BM25-style IDF weighting server-side at query time
 * (weightingStrategy: IDF), using document-frequency stats it maintains as
 * vectors are indexed.
 */
function sparseVector(text: string): SparseVector {
  const counts = new Map<number, number>();
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const bucket = fnv1a(token) % VOCAB_SIZE;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  const indices = [...counts.keys()].sort((a, b) => a - b);
  return { indices, values: indices.map((i) => counts.get(i)!) };
}

export type { SparseVector };
export { sparseVector };
