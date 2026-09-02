import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { sql } from "@/lib/db";
import { vectorIndex } from "@/lib/vector";
import { chunkId } from "@/lib/chunking";
import { documentCitationMeta } from "@/lib/documentMeta";
import { mapPool } from "@/lib/pool";

/**
 * POST /api/backfillCitations — fills in `version` and `publisher` on the
 * chunks of documents ingested before those fields were derived.
 *
 * Metadata-only: `metadataUpdateMode: "PATCH"` leaves the vectors untouched,
 * so this costs no embedding calls and cannot disturb chunk boundaries or the
 * chunkIds the graph relationships point at.
 *
 * It deliberately does not backfill page numbers. Those come from markers
 * `createMarkdown` now emits, and the persisted Markdown of an older document
 * has none — re-embedding reuses that same Markdown (`reembedDocument` skips
 * the PDF parse by design), so only a full re-ingest, or a separate pass that
 * aligns the PDF's pages to the stored chunks, can recover them.
 */
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id } = (await req.json().catch(() => ({}))) as { id?: string };

  try {
    const rows = id
      ? await sql`SELECT id, name, chunks FROM uploads WHERE id = ${id}`
      : await sql`SELECT id, name, chunks FROM uploads`;

    const documents: {
      name: string;
      version: string | null;
      publisher: string | null;
      chunksPatched: number;
    }[] = [];

    for (const row of rows) {
      const fileName = row.name as string;
      const chunkCount = Number(row.chunks) || 0;
      const { version, publisher } = documentCitationMeta(fileName);

      // Nothing derivable means nothing to write — skip rather than patch nulls
      // over whatever is already there.
      if (version === null && publisher === null) {
        documents.push({ name: fileName, version, publisher, chunksPatched: 0 });
        continue;
      }

      const metadata = {
        ...(version !== null ? { version } : {}),
        ...(publisher !== null ? { publisher } : {}),
      };

      const ids = Array.from({ length: chunkCount }, (_, i) => chunkId(fileName, i));
      const patched = await mapPool(ids, 10, async (chunk) => {
        try {
          const { updated } = await vectorIndex.update({
            id: chunk,
            metadata,
            metadataUpdateMode: "PATCH",
          });
          return updated;
        } catch (error) {
          // A chunk count that has drifted from the index leaves gaps; one
          // missing ID should not abandon the rest of the document.
          console.warn(`[backfillCitations] ${chunk} not patched:`, error);
          return 0;
        }
      });

      documents.push({
        name: fileName,
        version,
        publisher,
        chunksPatched: patched.reduce((total, n) => total + n, 0),
      });
    }

    return NextResponse.json({
      success: true,
      documents,
      chunksPatched: documents.reduce((total, doc) => total + doc.chunksPatched, 0),
    });
  } catch (error) {
    console.error("[backfillCitations] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to backfill citation metadata" },
      { status: 500 }
    );
  }
}
