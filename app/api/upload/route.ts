import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { del } from "@vercel/blob";
import { start } from "workflow/api";
import { sql } from "@/lib/db";
import { normalizeName, type UploadedFile } from "@/lib/upload";
import {
  attachRun,
  beginIngestionRun,
  isConcurrentIngestion,
  isMissingIngestionRunsTable,
  MISSING_INGESTION_RUNS_MESSAGE,
} from "@/lib/ingestionRuns";
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

  // Claim each accepted document before starting anything. The claim is the
  // durable handle on the run: `uploads` gets its row from the last step, so
  // without this nothing outside the browser tab knows the ingestion exists.
  //
  // The primary key on the claim also closes a gap the `uploads` lookup above
  // cannot see — two uploads of the same name in flight at once, neither of
  // them in `uploads` yet — which would otherwise leave the two runs
  // overwriting each other's chunks and graph edges.
  const inFlight: UploadedFile[] = [];
  const claimed: UploadedFile[] = [];

  for (const file of accepted) {
    try {
      await beginIngestionRun({
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
        blob: { url: file.url, downloadUrl: file.downloadUrl, pathname: file.pathname },
      });
      claimed.push(file);
    } catch (error) {
      if (isConcurrentIngestion(error)) {
        inFlight.push(file);
        continue;
      }
      if (isMissingIngestionRunsTable(error)) {
        // Ingestion worked without this table before it existed and still does;
        // it just cannot be recovered after a refresh. Say so once, loudly, in
        // the server log rather than refusing the upload.
        console.warn(`[upload] ${MISSING_INGESTION_RUNS_MESSAGE}`);
        claimed.push(file);
        continue;
      }
      console.error(`[upload] could not claim ${file.fileName}:`, error);
      return NextResponse.json(
        { success: false, error: "Could not record the ingestion; nothing was started" },
        { status: 500 }
      );
    }
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
  const orphaned = [...skipped, ...inFlight];
  if (orphaned.length > 0) {
    void Promise.all(
      orphaned.map((file) =>
        del(file.url).catch((error) =>
          console.warn(`[upload] could not delete orphaned blob ${file.pathname}:`, error)
        )
      )
    );
  }

  // Hand the run ID back so the client can poll GET /api/uploadStatus for
  // per-step progress. It is no longer the *only* handle on an in-flight
  // ingestion — the claim row above survives a refresh, and
  // GET /api/incompleteIngestions is how a run is found again without it.
  const runs = await Promise.all(
    claimed.map(async (file) => {
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
      // Best-effort: the claim row is what matters, and it is already written.
      // The run id only saves a lookup when resuming, so failing the upload
      // over it would trade a real ingestion for a convenience.
      await attachRun(file.fileName, run.runId).catch((error) =>
        console.warn(`[upload] could not attach run to ${file.fileName}:`, error)
      );
      return { fileName: file.fileName, runId: run.runId };
    })
  );

  return NextResponse.json({
    success: true,
    fileCount: claimed.length,
    runs,
    skipped: skipped.map((file) => file.fileName),
    inFlight: inFlight.map((file) => file.fileName),
  });
}
