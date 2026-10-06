import type { McpServer } from "@modelcontextprotocol/server";
import { sql } from "@/lib/db";
import { countsByDocument } from "@/lib/figureCounts";
import { documentEntries, type UploadRow } from "@/lib/documentList";

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

        // Counted from the index, in its own try/catch inside the one above.
        // A model needs these to know whether display_process is worth calling
        // for a document at all — but failing to count them must not cost the
        // list, which is this resource's actual job. One pass yields both:
        // they are told apart by their id namespace, not by separate scans.
        let counts: { figures: Map<string, number>; processes: Map<string, number> } | null = null;
        try {
          counts = await countsByDocument();
        } catch (err) {
          console.warn("[kb://documents] index counts unavailable:", err);
        }

        const documents = documentEntries(rows as unknown as UploadRow[], counts);

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              // Compact, not pretty-printed: this is read by a model, and the
              // indentation is tokens spent on whitespace.
              text: JSON.stringify({ documents }),
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
              text: JSON.stringify({
                error: `Could not read the document list: ${message}`,
                documents: [],
              }),
            },
          ],
        };
      }
    }
  );
}
