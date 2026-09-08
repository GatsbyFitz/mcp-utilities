import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { start } from "workflow/api";
import { sql } from "@/lib/db";
import { reextractFigures } from "./workflow";

/**
 * POST /api/extractFigures — extract and embed figures for one document
 * (`{ id }`) or for every document (no body).
 *
 * Additive by construction: figures live in their own vector-ID namespace, so
 * this never disturbs text chunks or the graph. That is what makes it safe to
 * run across the whole corpus without a re-ingest.
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
      ? await sql`
          SELECT id, name, blob_url, blob_download_url, blob_path, markdown_url
          FROM uploads WHERE id = ${id}
        `
      : await sql`
          SELECT id, name, blob_url, blob_download_url, blob_path, markdown_url
          FROM uploads
        `;

    // The PDF is required even when Markdown is persisted: pages are rendered
    // from it, and the Markdown only says which pages are worth rendering.
    const extractable = rows.filter((r) => r.blob_url && r.blob_download_url && r.blob_path);

    const runs = await Promise.all(
      extractable.map(async (row) => {
        const run = await start(reextractFigures, [
          {
            id: row.id,
            fileName: row.name,
            blobUrl: row.blob_url,
            blobDownloadUrl: row.blob_download_url,
            blobPath: row.blob_path,
            markdownUrl: row.markdown_url ?? null,
          },
        ]);
        return { fileName: row.name, runId: run.runId };
      })
    );

    return NextResponse.json({
      success: true,
      queued: runs.length,
      skipped: rows.length - extractable.length,
      runs,
    });
  } catch (error) {
    console.error("[extractFigures] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to queue figure extraction" },
      { status: 500 }
    );
  }
}
