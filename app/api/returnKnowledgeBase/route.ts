import { NextResponse } from "next/server";
import { sql } from "@/lib/db";


export async function GET() {
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