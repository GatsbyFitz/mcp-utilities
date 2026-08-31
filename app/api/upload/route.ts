import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { del } from "@vercel/blob";
import { start } from "workflow/api";
import { sql } from "@/lib/db";
import { normalizeName, type UploadedFile } from "@/lib/upload";
import { ingestPdf } from "./workflow";

/**
 * POST /api/upload — starts one ingestion workflow per already-uploaded file.
 *
 * The body is a small JSON manifest, never file bytes: the browser uploads
 * straight to Blob first (see /api/upload/token), so this route is unaffected
 * by the 4.5 MB function payload limit.
 */
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { files } = (await req.json().catch(() => ({}))) as {
    files?: UploadedFile[];
  };

  if (!Array.isArray(files) || files.length === 0) {
    return NextResponse.json(
      { success: false, error: "No uploaded files supplied" },
      { status: 400 }
    );
  }

  if (files.some((file) => !file?.fileName || !file?.url || !file?.pathname)) {
    return NextResponse.json(
      { success: false, error: "An uploaded file is missing its name or blob URL" },
      { status: 400 }
    );
  }

  // The token route already refuses a duplicate before the bytes are sent.
  // This check is the authoritative one: it cannot be bypassed by a client
  // that skipped that route, and it closes the window between the two.
  let existingNames: Set<string>;
  try {
    const candidates = files.map((file) => normalizeName(file.fileName));
    const rows = await sql`
      SELECT name FROM uploads
      WHERE LOWER(TRIM(name)) = ANY(${candidates}::text[])
    `;
    existingNames = new Set(rows.map((row) => normalizeName(row.name)));
  } catch (error) {
    console.error("[upload] duplicate check failed:", error);
    // Fail closed. Ingesting a duplicate corrupts the existing document's
    // chunks and graph edges, which is worse than asking for a retry.
    return NextResponse.json(
      { success: false, error: "Could not verify existing documents; nothing was ingested" },
      { status: 500 }
    );
  }

  // `seen` also catches the same name appearing twice within this one batch,
  // which no database lookup can see.
  const seen = new Set<string>();
  const accepted: UploadedFile[] = [];
  const skipped: UploadedFile[] = [];

  for (const file of files) {
    const key = normalizeName(file.fileName);
    if (existingNames.has(key) || seen.has(key)) {
      skipped.push(file);
      continue;
    }
    seen.add(key);
    accepted.push(file);
  }

  // A skipped file was uploaded but will never be ingested, so its blob is
  // orphaned. Safe to remove: each upload gets its own uuid-prefixed pathname,
  // so this never touches the existing document's blob.
  //
  // Deliberately not awaited. Cleanup is housekeeping and must never delay or
  // fail the caller's request — an unreachable Blob API would otherwise hang
  // the response. The trade is that the function may be frozen before the
  // delete lands, leaving the blob in place; `waitUntil` from
  // @vercel/functions would close that gap if it ever proves to matter.
  if (skipped.length > 0) {
    void Promise.all(
      skipped.map((file) =>
        del(file.url).catch((error) =>
          console.warn(`[upload] could not delete orphaned blob ${file.pathname}:`, error)
        )
      )
    );
  }

  // The run ID is the only handle on an in-flight ingestion — nothing is
  // written to Postgres until `recordUpload`, the last step. Hand it back so
  // the client can poll GET /api/uploadStatus for per-step progress.
  const runs = await Promise.all(
    accepted.map(async (file) => {
      const run = await start(ingestPdf, [
        {
          fileName: file.fileName,
          sizeBytes: file.sizeBytes,
          blob: {
            url: file.url,
            downloadUrl: file.downloadUrl,
            pathname: file.pathname,
          },
        },
      ]);
      return { fileName: file.fileName, runId: run.runId };
    })
  );

  return NextResponse.json({
    success: true,
    fileCount: accepted.length,
    runs,
    skipped: skipped.map((file) => file.fileName),
  });
}
