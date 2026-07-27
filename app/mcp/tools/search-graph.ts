import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { embed } from "ai";
import { vectorIndex } from "@/lib/vector";
import { withSession } from "@/lib/graph";
import { toCitation, citationLine, type ChunkMetadata } from "@/lib/citations";

interface RelationRow {
  source: string;
  relType: string;
  description: string;
  target: string;
  chunkId: string;
  sourceDoc: string;
  hops: number;
}

/** "Metering Provider —notifies→ Distributor" */
function pathLine(n: number, r: RelationRow): string {
  return (
    `[R${n}] ${r.source} \u2014${r.relType}\u2192 ${r.target}` +
    ` (${r.sourceDoc})\n${r.description}`
  );
}

export function registerSearchGraphTool(server: McpServer): void {
  server.registerTool(
    "search_graph",
    {
      title: "search_graph",
      description:
        "Search the knowledge graph of entities and relationships extracted " +
        "from uploaded documents. Use for relational questions: obligations " +
        "or dependencies between parties, how concepts connect, definitions " +
        "that span documents, or 'what links X to Y'. Returns relationship " +
        "paths [R1], [R2], ... plus supporting document excerpts [1], [2], " +
        "... with citation headers. For direct factual lookups within one " +
        "topic, use search_docs instead. Cite claims using document title, " +
        "version, and page range, and include each document's URL at most once.",
      inputSchema: z.object({
        query: z.string().min(2).max(1000),
        maxHops: z.number().int().min(1).max(2).default(2),
        maxChunks: z.number().int().min(1).max(8).default(5),
      }),
    },
    async ({ query, maxHops, maxChunks }) => {
      try {
        const { embedding } = await embed({
          model: "google/gemini-embedding-2",
          value: `task: search result | query: ${query}`,
          providerOptions: {
            google: { outputDimensionality: 1536, taskType: "RETRIEVAL_QUERY" },
          },
        });

        // Neo4j can't parameterize variable-length bounds (*1..$n), so the
        // clamped integer is interpolated. maxHops is schema-validated 1–2.
        const hops = Math.min(Math.max(maxHops, 1), 2);

        const result = await withSession((s) =>
          s.executeRead((tx) =>
            tx.run(
              `
              CALL db.index.vector.queryNodes('entity_names', 5, $embedding)
              YIELD node AS seed, score
              WHERE score > 0.6
              MATCH p = (seed)-[:RELATES*1..${hops}]-(:Entity)
              UNWIND relationships(p) AS r
              WITH DISTINCT r, length(p) AS hops
              RETURN startNode(r).name  AS source,
                     r.type             AS relType,
                     r.description      AS description,
                     endNode(r).name    AS target,
                     r.chunkId          AS chunkId,
                     r.sourceDoc        AS sourceDoc,
                     min(hops)          AS hops
              ORDER BY hops ASC
              LIMIT 30
              `,
              { embedding }
            )
          )
        );

        const relations: RelationRow[] = result.records.map((rec) => ({
          source: rec.get("source"),
          relType: rec.get("relType"),
          description: rec.get("description") ?? "",
          target: rec.get("target"),
          chunkId: rec.get("chunkId"),
          sourceDoc: rec.get("sourceDoc"),
          hops: rec.get("hops")?.toNumber?.() ?? Number(rec.get("hops")),
        }));

        if (relations.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No graph matches for "${query}". The knowledge graph ` +
                  `covers entities and relationships from uploaded documents; ` +
                  `try search_docs for direct content search.`,
              },
            ],
            structuredContent: { query, relations: [], excerpts: [] },
          };
        }

        // Fetch supporting chunks for the closest-hop relations, deduped.
        const chunkIds = [...new Set(relations.map((r) => r.chunkId))].slice(
          0,
          maxChunks
        );
        const chunks = await vectorIndex.fetch(chunkIds, {
          includeMetadata: true,
        });

        const excerpts = chunks.flatMap((c, i) => {
          if (!c?.metadata) return [];
          const md = c.metadata as ChunkMetadata;
          return [
            {
              n: i + 1,
              id: c.id,
              citation: toCitation(md),
              text: md.text ?? "",
            },
          ];
        });

        const renderedPaths = relations
          .map((r, i) => pathLine(i + 1, r))
          .join("\n\n");

        const renderedExcerpts = excerpts
          .map(
            (e) =>
              // Graph results carry no similarity score; pass hop-derived 1.0
              // or refactor citationLine to make the score optional.
              `${citationLine(e.n, e.citation, 1.0)}\n${e.text.trim()}`
          )
          .join("\n\n---\n\n");

        const sources = [
          ...new Map(excerpts.map((e) => [e.citation.source, e.citation])).values(),
        ]
          .map(
            (c) =>
              `- ${c.title}${c.version ? ` v${c.version}` : ""}: ${
                c.url ?? "no URL in index"
              }`
          )
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Found ${relations.length} relationship(s) for "${query}".\n\n` +
                `Relationships:\n\n${renderedPaths}\n\n` +
                `Supporting excerpts:\n\n${renderedExcerpts}\n\n` +
                `Sources:\n${sources}`,
            },
          ],
          structuredContent: { query, relations, excerpts },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `search_graph failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}