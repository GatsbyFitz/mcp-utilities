import { generateObject, embedMany } from "ai";
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

const ExtractionSchema = z.object({
  entities: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        type: z
          .string()
          .max(60)
          .describe("Short category: Party, Role, System, Concept, Obligation, Document"),
      })
    )
    .max(30),
  relationships: z
    .array(
      z.object({
        source: z.string().min(1).max(120),
        relationType: z.string().min(1).max(60),
        target: z.string().min(1).max(120),
        description: z.string().min(1).max(400),
      })
    )
    .max(40),
});

interface PendingRelation {
  source: string;
  relType: string;
  description: string;
  target: string;
  chunkId: string;
  sourceDoc: string;
}

/** Collapse whitespace so "Metering  Provider\n" and "Metering Provider" MERGE as one node. */
function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
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
    const { object } = await generateObject({
      model: "google/gemini-3-flash",
      schema: ExtractionSchema,
      prompt: `${EXTRACT_PROMPT}\n\nDocument: ${title}\n\nExcerpt:\n${chunk}`,
    });

    // The model is told both endpoints must be declared entities, but it
    // sometimes references one it forgot to list. Take the union of declared
    // entities and relationship endpoints rather than dropping the edge.
    const types = new Map<string, string>();
    for (const e of object.entities) {
      const name = normalizeName(e.name);
      if (name) types.set(name, e.type);
    }

    const relations: PendingRelation[] = [];
    for (const r of object.relationships) {
      const source = normalizeName(r.source);
      const target = normalizeName(r.target);
      if (!source || !target || source === target) continue;
      if (!types.has(source)) types.set(source, "");
      if (!types.has(target)) types.set(target, "");
      relations.push({
        source,
        target,
        relType: normalizeName(r.relationType).toUpperCase().replace(/\s+/g, "_"),
        description: r.description.trim(),
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
      google: { outputDimensionality: 1536, taskType: "RETRIEVAL_DOCUMENT" },
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
