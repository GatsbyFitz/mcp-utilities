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
    }
  );
}
