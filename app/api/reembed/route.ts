import { NextRequest, NextResponse } from "next/server";
import { start } from "workflow/api";
import { sql } from "@/lib/db";
import { reembedDocument } from "./workflow";

export async function POST(req: NextRequest) {
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

    const reembeddable = rows.filter((r) => r.blob_url && r.blob_download_url && r.blob_path);

    await Promise.all(
      reembeddable.map((row) =>
        start(reembedDocument, [
          {
            id: row.id,
            fileName: row.name,
            blobUrl: row.blob_url,
            blobDownloadUrl: row.blob_download_url,
            blobPath: row.blob_path,
            markdownUrl: row.markdown_url ?? null,
          },
        ])
      )
    );

    return NextResponse.json({
      success: true,
      queued: reembeddable.length,
      skipped: rows.length - reembeddable.length,
    });
  } catch (error) {
    console.error("[reembed] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to queue re-embedding" },
      { status: 500 }
    );
  }
}
