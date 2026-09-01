import type { McpServer } from "@modelcontextprotocol/server";
import { sql } from "@/lib/db";

export function registerDocumentsResource(server: McpServer): void {
  server.registerResource(
    "documents",
    "kb://documents",
    {
      title: "Indexed documents",
      description:
        "All documents currently embedded in the vector index and knowledge " +
        "graph, as recorded by the ingestion workflow's final step.",
      mimeType: "application/json",
    },
    async (uri) => {
      // Nothing under app/mcp/** may let an error escape: an uncaught throw
      // here surfaces to the client as a JSON-RPC -32603 protocol failure
      // rather than something it can read. A resource has no `isError` flag
      // the way a tool does, so the failure is reported inside the payload
      // instead, keeping the declared application/json shape.
      try {
        const rows = await sql`
          SELECT id, name, chunks, size_bytes, uploaded_at, blob_url
          FROM uploads
          ORDER BY uploaded_at DESC
        `;

        const documents = rows.map((row) => ({
          id: row.id,
          name: row.name,
          chunks: row.chunks,
          sizeBytes: row.size_bytes,
          uploadedAt: row.uploaded_at,
          blobUrl: row.blob_url ?? null,
        }));

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ documents }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[kb://documents] read failed:", err);

        // `documents: []` so a consumer that only reads the list degrades to
        // "nothing indexed" rather than crashing on a missing field, while
        // one that checks `error` learns the list is unavailable, not empty.
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                { error: `Could not read the document list: ${message}`, documents: [] },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}
