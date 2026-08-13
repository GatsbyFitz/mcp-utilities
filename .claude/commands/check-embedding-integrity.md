---
description: Verify embedding integrity across the hybrid (Upstash) and graph (Neo4j) paths
---

Both paths must hold to one contract: `google/gemini-embedding-2` at
`outputDimensionality: 1536`, `RETRIEVAL_DOCUMENT` on ingest / `RETRIEVAL_QUERY`
on query, with prefix strings kept in sync on each side (`title: … | text: …`
vs `task: search result | query: …` for hybrid; `entity: … | type: …` vs its
query-side counterpart for graph). Integrity here means: every stored vector
is well-formed, every vector is *correct* (matches what re-embedding the same
input produces), and every vector is *reachable* (a real query actually
retrieves it). Checking only the first without the other two would pass on a
stored-but-wrong or stored-but-orphaned vector.

## 1. Well-formed
For a document already ingested (check Neon `uploads`):
- Upstash: sample its vectors, confirm `vector` is length 1536 and non-zero,
  `sparseVector` is present and non-empty.
- Neo4j: confirm the `entity_names` vector index exists at dimension 1536
  (`SHOW INDEXES`) — provisioned outside this repo per `data-stores.md`, so
  it can silently be missing or mismatched. Confirm a sampled entity from
  that document has a non-null `embedding` of length 1536.

## 2. Correct (no silent drift)
- Re-embed a stored chunk's exact text locally with the same
  model/taskType/prefix used in `createEmbeddings`, diff against the stored
  vector. Do the same for a stored entity name against `extractGraph`'s
  convention. This is the check that catches the prefix or taskType
  convention falling out of sync between an ingest step and its query-side
  counterpart in `app/mcp/tools/`.

## 3. Reachable (the failure mode with no exception)
- Run `search_docs` with a query built from that chunk's actual text; confirm
  the chunk surfaces in results — exercises dense + sparse (`WeightingStrategy.IDF`)
  + Cohere rerank together, not just that a vector exists.
- Run `search_graph` for that entity (or a close paraphrase); confirm it
  resolves rather than 0 hits.
- Confirm a `chunkId` on a returned graph relationship round-trips through
  `vectorIndex.fetch()` to a real chunk, matching the `${file.name}-${i}`
  join `data-stores.md` calls out explicitly.

Report each check pass/fail with the specific document, chunk, or entity
used — a silent 0-result match is the real failure mode, not a thrown error.