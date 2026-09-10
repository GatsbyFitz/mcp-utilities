import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { list } from "@vercel/blob";
import { start } from "workflow/api";
import { sql } from "@/lib/db";
import { normalizeName } from "@/lib/upload";
import {
  attachRun,
  isMissingIngestionRunsTable,
  recordResumePoint,
} from "@/lib/ingestionRuns";
import { findStrandedMarkdown, type BlobRef, type StrandedMarkdown } from "@/lib/strandedMarkdown";
import { resumeIngest } from "../upload/workflow";

/** Blob pages at 1,000 by default; a corpus outgrows one page, so follow the cursor. */
async function listAll(prefix: string): Promise<BlobRef[]> {
  const all: BlobRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    for (const blob of page.blobs) {
      all.push({
        url: blob.url,
        downloadUrl: blob.downloadUrl,
        pathname: blob.pathname,
        size: blob.size,
        uploadedAt: new Date(blob.uploadedAt).toISOString(),
      });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return all;
}

/** Names already tracked in `ingestion_runs`, or an empty set if it has none. */
async function trackedNames(): Promise<Set<string>> {
  try {
    const rows = (await sql`SELECT name FROM ingestion_runs`) as { name: string }[];
    return new Set(rows.map((row) => row.name));
  } catch (error) {
    if (isMissingIngestionRunsTable(error)) return new Set();
    throw error;
  }
}

async function ingestedNames(): Promise<Set<string>> {
  const rows = (await sql`SELECT name FROM uploads`) as { name: string }[];
  return new Set(rows.map((row) => normalizeName(row.name)));
}

async function scan(): Promise<StrandedMarkdown[]> {
  const [markdownBlobs, pdfBlobs, ingested, tracked] = await Promise.all([
    listAll("markdown/"),
    listAll("uploads/"),
    ingestedNames(),
    trackedNames(),
  ]);

  return findStrandedMarkdown(markdownBlobs, pdfBlobs, ingested, tracked);
}

/**
 * GET /api/strandedMarkdown — Markdown in Blob with no finished document behind it.
 *
 * The companion to /api/incompleteIngestions rather than a replacement for it.
 * That route reports what the database knows it started; this one reads the
 * store directly and so also finds runs from before anything tracked them —
 * every parse the corpus has paid for and never turned into a document.
 *
 * A result is only listed when the original PDF is still in Blob too, because
 * finishing the ingestion needs it for figure extraction and for the blob URL
 * that ends up in citations.
 */
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const items = await scan();
    return NextResponse.json({ success: true, items });
  } catch (error) {
    console.error("[strandedMarkdown] GET failed:", error);
    return NextResponse.json(
      { success: false, error: "Could not scan stored Markdown" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/strandedMarkdown  { fileName }
 *
 * Restarts ingestion for one suggestion, from its saved Markdown.
 *
 * The scan is re-run rather than trusting URLs from the request: a caller names
 * a document and the server decides what that resolves to, so this cannot be
 * used to point the pipeline at an arbitrary blob. Restarting also writes the
 * `ingestion_runs` row the original run never had, which is what lets
 * /api/incompleteIngestions take over tracking it from here.
 */
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { fileName } = (await req.json().catch(() => ({}))) as { fileName?: string };
  if (!fileName) {
    return NextResponse.json({ success: false, error: "Missing fileName" }, { status: 400 });
  }

  try {
    const wanted = normalizeName(fileName);
    const candidate = (await scan()).find((item) => normalizeName(item.fileName) === wanted);

    if (!candidate) {
      // Either it was never stranded, or it finished in the meantime — a
      // document in `uploads` is deliberately excluded from the scan.
      return NextResponse.json(
        {
          success: false,
          error: "No stranded Markdown for that document. It may already be in the knowledge base.",
        },
        { status: 404 }
      );
    }

    const resume = {
      fileName: candidate.fileName,
      sizeBytes: candidate.sizeBytes,
      blob: candidate.blob,
      markdownUrl: candidate.markdownUrl,
    };

    await recordResumePoint(resume).catch((error) => {
      if (!isMissingIngestionRunsTable(error)) throw error;
      console.warn("[strandedMarkdown] ingestion_runs table missing; starting untracked");
    });

    const run = await start(resumeIngest, [resume]);
    await attachRun(resume.fileName, run.runId).catch((error) =>
      console.warn(`[strandedMarkdown] could not attach run to ${resume.fileName}:`, error)
    );

    return NextResponse.json({ success: true, runId: run.runId, fileName: resume.fileName });
  } catch (error) {
    console.error("[strandedMarkdown] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Could not restart ingestion" },
      { status: 500 }
    );
  }
}
