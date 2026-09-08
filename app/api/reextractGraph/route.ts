import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { start } from "workflow/api";
import { sql } from "@/lib/db";
import { reextractGraph } from "./workflow";

/**
 * POST /api/reextractGraph — rebuild the knowledge graph for one document
 * (`{ id }`) or for every document (no body).
 *
 * The cheap half of `POST /api/reembed`: same graph result, without
 * contextualising and re-embedding chunks that have not changed. See the
 * chunking caveat on `reextractGraph` before reaching for this after editing
 * lib/chunking.ts.
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
          SELECT id, name, blob_url, markdown_url
          FROM uploads WHERE id = ${id}
        `
      : await sql`
          SELECT id, name, blob_url, markdown_url
          FROM uploads
        `;

    // A row with neither markdown nor a blob has no source to extract from.
    const extractable = rows.filter((r) => r.markdown_url || r.blob_url);

    const runs = await Promise.all(
      extractable.map(async (row) => {
        const run = await start(reextractGraph, [
          {
            id: row.id,
            fileName: row.name,
            blobUrl: row.blob_url,
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
    console.error("[reextractGraph] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to queue graph re-extraction" },
      { status: 500 }
    );
  }
}
