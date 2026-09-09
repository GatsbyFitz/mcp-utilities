import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { sql } from "@/lib/db";
import { figureCountsByDocument } from "@/lib/figureCounts";


export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    const rows = await sql`
      SELECT
        id,
        name,
        chunks,
        size_bytes,
        uploaded_at,
        blob_url,
        blob_download_url,
        blob_path
      FROM uploads
      ORDER BY uploaded_at DESC
    `;


    // Counted from the vector index, not stored on the row. A figure count is
    // a claim about the index, and one kept in Postgres would go stale the
    // moment an extraction partly failed or was re-run with fewer results.
    //
    // Failing to count must not fail the knowledge base: the table's job is to
    // list documents, and it should still do that when Upstash is unreachable.
    // `null` then means "not known", which the UI shows as such rather than
    // as zero — the difference between "no figures" and "could not ask".
    let figures: Map<string, number> | null = null;
    try {
      figures = await figureCountsByDocument();
    } catch (error) {
      console.warn("[returnKnowledgeBase] figure counts unavailable:", error);
    }

    return NextResponse.json({
      success: true,
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        chunks: row.chunks,
        sizeBytes: row.size_bytes,
        uploadedAt: row.uploaded_at,
        blobUrl: row.blob_url ?? null,
        blobDownloadUrl: row.blob_download_url ?? null,
        blobPath: row.blob_path ?? null,
        figures: figures ? (figures.get(row.name) ?? 0) : null,
      })),
    });
  } catch (error) {
    console.error("[returnKnowledgeBase] GET failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch knowledge base records",
      },
      { status: 500 }
    );
  }
}