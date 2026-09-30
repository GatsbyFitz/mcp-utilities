import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { start } from "workflow/api";
import { sql } from "@/lib/db";
import { reextractProcesses } from "./workflow";

/**
 * POST /api/extractProcesses — read processes out of one document's figures
 * (`{ id }`) or out of every document's (no body).
 *
 * Additive by construction, like figures: processes live in their own vector-ID
 * namespace, so this disturbs no text chunk, no figure and nothing in the
 * graph. That is what makes it safe to run across the whole corpus without a
 * re-ingest — and unlike figure extraction it never opens the PDF, so it is
 * cheap enough to re-run whenever the prompt changes.
 *
 * A document with no figures yet queues anyway and finishes having found none;
 * figures come from POST /api/extractFigures, which is the step before this one.
 */
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = (await req.json().catch(() => ({}))) as { id?: string };

  try {
    const rows = id
      ? await sql`
          SELECT id, name, blob_url, blob_download_url, blob_path
          FROM uploads WHERE id = ${id}
        `
      : await sql`
          SELECT id, name, blob_url, blob_download_url, blob_path
          FROM uploads
        `;

    // The blob fields are only carried into the citation, but a row missing
    // them would produce processes that cite nothing, so skip it rather than
    // index something unciteable.
    const scannable = rows.filter((r) => r.blob_url && r.blob_download_url && r.blob_path);

    const runs = await Promise.all(
      scannable.map(async (row) => {
        const run = await start(reextractProcesses, [
          {
            fileName: row.name,
            blobUrl: row.blob_url,
            blobDownloadUrl: row.blob_download_url,
            blobPath: row.blob_path,
          },
        ]);
        return { fileName: row.name, runId: run.runId };
      })
    );

    return NextResponse.json({
      success: true,
      queued: runs.length,
      skipped: rows.length - scannable.length,
      runs,
    });
  } catch (error) {
    console.error("[extractProcesses] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to queue process extraction" },
      { status: 500 }
    );
  }
}
