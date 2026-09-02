import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { readGraph } from "@/lib/graph";

/**
 * GET /api/graph — the whole knowledge graph, for the visualiser at /graph.
 *
 * Unlike `search_graph`, this takes no query and does no embedding: it reads
 * every persisted relationship, up to a cap. `extractGraph` never persists an
 * entity that has no edge (an isolated node is unreachable from search_graph's
 * MATCH), so deriving nodes from the edge list loses nothing.
 */

const DEFAULT_EDGE_LIMIT = 2000;
const MAX_EDGE_LIMIT = 6000;

interface GraphEdge {
  source: string;
  target: string;
  type: string;
  description: string;
  sourceDoc: string;
}

interface GraphNode {
  name: string;
  type: string | null;
  degree: number;
}

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const requested = Number(req.nextUrl.searchParams.get("limit"));
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.trunc(requested), MAX_EDGE_LIMIT)
      : DEFAULT_EDGE_LIMIT;

  try {
    const { edges, nodeTypes, relationshipCount, entityCount } = await readGraph(
      async (tx) => {
        // Highest-degree entities first, so a truncated graph is the
        // well-connected core rather than an arbitrary slice.
        const edgeResult = await tx.run(
          `
          MATCH (a:Entity)-[r:RELATES]->(b:Entity)
          WITH a, b, r,
               COUNT { (a)-[:RELATES]-() } + COUNT { (b)-[:RELATES]-() } AS weight
          ORDER BY weight DESC
          LIMIT $limit
          RETURN a.name       AS source,
                 b.name       AS target,
                 a.type       AS sourceType,
                 b.type       AS targetType,
                 r.type       AS relType,
                 r.description AS description,
                 r.sourceDoc  AS sourceDoc
          `,
          { limit }
        );

        const countResult = await tx.run(
          `
          MATCH (n:Entity)
          WITH count(n) AS entityCount
          MATCH ()-[r:RELATES]->()
          RETURN entityCount, count(r) AS relationshipCount
          `
        );

        const rows = edgeResult.records;
        const types = new Map<string, string | null>();
        const list: GraphEdge[] = rows.map((rec) => {
          const source = rec.get("source") as string;
          const target = rec.get("target") as string;
          if (!types.get(source)) types.set(source, rec.get("sourceType") ?? null);
          if (!types.get(target)) types.set(target, rec.get("targetType") ?? null);
          return {
            source,
            target,
            type: rec.get("relType") ?? "",
            description: rec.get("description") ?? "",
            sourceDoc: rec.get("sourceDoc") ?? "",
          };
        });

        const counts = countResult.records[0];
        return {
          edges: list,
          nodeTypes: types,
          entityCount: (counts?.get("entityCount") as number) ?? 0,
          relationshipCount: (counts?.get("relationshipCount") as number) ?? 0,
        };
      }
    );

    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }

    const nodes: GraphNode[] = [...degree.entries()].map(([name, count]) => ({
      name,
      type: nodeTypes.get(name) ?? null,
      degree: count,
    }));

    const documents = [...new Set(edges.map((e) => e.sourceDoc).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b)
    );

    return NextResponse.json({
      success: true,
      nodes,
      edges,
      documents,
      stats: {
        entityCount,
        relationshipCount,
        // What this response actually carries, which is less than the totals
        // above whenever the cap bit.
        returnedNodes: nodes.length,
        returnedEdges: edges.length,
        truncated: edges.length < relationshipCount,
        limit,
      },
    });
  } catch (error) {
    console.error("[graph] GET failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to read the knowledge graph" },
      { status: 500 }
    );
  }
}
