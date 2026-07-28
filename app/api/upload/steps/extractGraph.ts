import { embedMany, generateText, Output } from "ai";
import * as z from "zod/v4";
import { writeGraph } from "@/lib/graph";
import { chunkId, chunkText, extractTitle } from "@/lib/chunking";

// ---------------------------------------------------------------------------
// Step 4: Extract entities + relationships into the Neo4j knowledge graph
// ---------------------------------------------------------------------------
// Produces exactly what search_graph reads: (:Entity {name, type, embedding})
// nodes joined by [:RELATES {type, description, chunkId, sourceDoc}] edges,
// with entity names indexed by the `entity_names` vector index.

const EXTRACT_PROMPT = `Extract the entities and the relationships between them from the document excerpt below.

Rules:
- An entity is a named party, role, system, obligation, or defined concept (e.g. "Metering Provider", "Distributor", "Settlement Window"). Not generic nouns.
- Use the exact name as written in the text. Do not abbreviate, expand acronyms, or invent names.
- Prefer the canonical/defined form when the text introduces one (e.g. use "Metering Provider" even where the excerpt later says "the MP").
- A relationship must be stated or directly implied by THIS excerpt. Do not infer from outside knowledge.
- relationType is a short UPPER_SNAKE_CASE verb phrase: NOTIFIES, MUST_PROVIDE, IS_RESPONSIBLE_FOR, DEFINED_AS, REPORTS_TO.
- description is one sentence, grounded in the excerpt, explaining the relationship.
- Both source and target must appear in your entities list.
- If the excerpt is boilerplate, a table of contents, or has no substantive relationships, return empty arrays.`;

// Deliberately unconstrained: Gemini's structured-output mode drops most JSON
// Schema string/array constraints, so `.min`/`.max` here would not steer the
// model but would still reject the response — one over-long description would
// throw away the whole chunk. Limits are enforced in code below instead.
// The arrays default to empty because the model tends to omit them entirely on
// boilerplate rather than return `[]` as instructed.
const ExtractionSchema = z.object({
  entities: z
    .array(
      z.object({
        name: z.string(),
        type: z
          .string()
          .describe("Short category: Party, Role, System, Concept, Obligation, Document"),
      })
    )
    .default([]),
  relationships: z
    .array(
      z.object({
        source: z.string(),
        relationType: z.string(),
        target: z.string(),
        description: z.string(),
      })
    )
    .default([]),
});

const MAX_ENTITIES = 30;
const MAX_RELATIONSHIPS = 40;
const MAX_NAME = 120;
const MAX_TYPE = 60;
const MAX_DESCRIPTION = 400;

interface PendingRelation {
  source: string;
  relType: string;
  description: string;
  target: string;
  chunkId: string;
  sourceDoc: string;
}

/** Collapse whitespace so "Metering  Provider\n" and "Metering Provider" MERGE as one node. */
function normalizeName(name: string, limit = MAX_NAME): string {
  return name.trim().replace(/\s+/g, " ").slice(0, limit);
}

/** Run `worker` over items with bounded concurrency. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function extractGraph(fileName: string, markdown: string) {
  "use step";

  const title = extractTitle(markdown, fileName);
  const chunks = chunkText(markdown);

  // Extract per chunk so chunkId attribution is structural rather than
  // something the model has to get right. Concurrency caps the burst.
  const perChunk = await mapPool(chunks, 5, async (chunk, i) => {
    const types = new Map<string, string>();
    const relations: PendingRelation[] = [];

    let output: z.infer<typeof ExtractionSchema>;
    try {
      ({ output } = await generateText({
        model: "google/gemini-3.5-flash-lite",
        output: Output.object({ schema: ExtractionSchema }),
        prompt: `${EXTRACT_PROMPT}\n\nDocument: ${title}\n\nExcerpt:\n${chunk}`,
      }));
    } catch (error) {
      // mapPool awaits every runner together, so an unhandled throw here sinks
      // an upload that has already paid for parsing and embedding. Drop the
      // chunk, loudly, and keep the rest of the graph.
      console.warn(
        `[extractGraph] ${fileName} chunk ${i + 1}/${chunks.length}: extraction failed, skipping`,
        error
      );
      return { types, relations };
    }

    // The model is told both endpoints must be declared entities, but it
    // sometimes references one it forgot to list. Take the union of declared
    // entities and relationship endpoints rather than dropping the edge.
    for (const e of output.entities.slice(0, MAX_ENTITIES)) {
      const name = normalizeName(e.name);
      if (name) types.set(name, normalizeName(e.type, MAX_TYPE));
    }

    for (const r of output.relationships.slice(0, MAX_RELATIONSHIPS)) {
      const source = normalizeName(r.source);
      const target = normalizeName(r.target);
      const relType = normalizeName(r.relationType, MAX_TYPE)
        .toUpperCase()
        .replace(/\s+/g, "_");
      const description = r.description.trim().slice(0, MAX_DESCRIPTION);
      if (!source || !target || source === target || !relType || !description) continue;
      if (!types.has(source)) types.set(source, "");
      if (!types.has(target)) types.set(target, "");
      relations.push({
        source,
        target,
        relType,
        description,
        chunkId: chunkId(fileName, i),
        sourceDoc: fileName,
      });
    }

    return { types, relations };
  });

  // An entity only earns a node if it participates in at least one edge —
  // isolated nodes are unreachable via the MATCH in search_graph and would
  // just add noise to the `entity_names` index.
  const relations = perChunk.flatMap((r) => r.relations);
  const connected = new Set(relations.flatMap((r) => [r.source, r.target]));
  const entityTypes = new Map<string, string>();
  for (const { types } of perChunk) {
    for (const [name, type] of types) {
      if (!connected.has(name)) continue;
      // First non-empty type wins; later chunks shouldn't clobber a good label.
      if (!entityTypes.get(name) && type) entityTypes.set(name, type);
      else if (!entityTypes.has(name)) entityTypes.set(name, type);
    }
  }

  const names = [...entityTypes.keys()];

  if (names.length === 0) {
    // Still clear stale edges from a previous version of this document.
    await replaceDocumentGraph(fileName, [], []);
    return { entityCount: 0, relationCount: 0 };
  }

  // Document-side embedding of the entity name, mirroring the asymmetric
  // convention used for chunks (RETRIEVAL_DOCUMENT here, RETRIEVAL_QUERY in
  // search_graph). Including the type gives the short name some context.
  const { embeddings } = await embedMany({
    model: "google/gemini-embedding-2",
    values: names.map((name) => {
      const type = entityTypes.get(name);
      return type ? `entity: ${name} | type: ${type}` : `entity: ${name}`;
    }),
    providerOptions: {
      google: { outputDimensionality: 1536},
    },
  });

  const entities = names.map((name, i) => ({
    name,
    type: entityTypes.get(name) || null,
    embedding: embeddings[i],
  }));

  await replaceDocumentGraph(fileName, entities, relations);

  return { entityCount: entities.length, relationCount: relations.length };
}

interface PendingEntity {
  name: string;
  type: string | null;
  embedding: number[];
}

/**
 * Idempotent write: re-uploading a document replaces its edges instead of
 * duplicating them. Entities are MERGEd because they are shared across
 * documents; only this document's relationships are deleted.
 */
async function replaceDocumentGraph(
  fileName: string,
  entities: PendingEntity[],
  relations: PendingRelation[]
) {
  await writeGraph(async (tx) => {
    await tx.run(
      `MATCH ()-[r:RELATES {sourceDoc: $fileName}]->() DELETE r`,
      { fileName }
    );

    if (entities.length > 0) {
      await tx.run(
        `
        UNWIND $entities AS e
        MERGE (n:Entity {name: e.name})
        SET n.type = coalesce(e.type, n.type)
        WITH n, e
        CALL db.create.setNodeVectorProperty(n, 'embedding', e.embedding)
        `,
        { entities }
      );
    }

    if (relations.length > 0) {
      await tx.run(
        `
        UNWIND $relations AS r
        MATCH (a:Entity {name: r.source})
        MATCH (b:Entity {name: r.target})
        CREATE (a)-[:RELATES {
          type:        r.relType,
          description: r.description,
          chunkId:     r.chunkId,
          sourceDoc:   r.sourceDoc
        }]->(b)
        `,
        { relations }
      );
    }

    // Entities left stranded by the delete above (only referenced by the
    // previous version of this document) would otherwise pollute the index.
    await tx.run(`MATCH (n:Entity) WHERE NOT (n)-[:RELATES]-() DELETE n`);
  });
}
