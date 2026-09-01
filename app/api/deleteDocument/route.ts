import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { del } from "@vercel/blob";
import { sql } from "@/lib/db";
import { vectorIndex } from "@/lib/vector";
import { replaceDocumentGraph } from "../upload/steps/extractGraph";

/**
 * Escapes single quotes for Upstash's SQL-like filter syntax. fileName comes
 * from the original uploaded filename, which is user-controlled.
 */
function escapeFilterValue(value: string): string {
  return value.replace(/'/g, "''");
}

export async function DELETE(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) {
    return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
  }

  try {
    const rows = await sql`
      SELECT id, name, blob_url, markdown_url FROM uploads WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) {
      return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
    }

    // Dependent resources first; the uploads row is the source of truth for
    // what to clean up, so it's only deleted once everything else succeeds —
    // a failure partway through leaves the row (and a retry path) intact
    // rather than orphaning blob/vector/graph data with nothing left to find it.
    // Filtered by exact metadata match, not an ID prefix: chunkId is
    // `${fileName}-${index}`, so a prefix delete for "report-" would also
    // catch a differently-named document like "report-2"'s chunks.
    await vectorIndex.delete({ filter: `source = '${escapeFilterValue(row.name)}'` });
    
    await replaceDocumentGraph(row.name, [], []);

    const blobUrls = [row.blob_url, row.markdown_url].filter((u): u is string => Boolean(u));
    if (blobUrls.length > 0) {
      await del(blobUrls);
    }

    await sql`DELETE FROM uploads WHERE id = ${id}`;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[deleteDocument] DELETE failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to delete document" },
      { status: 500 }
    );
  }
}
