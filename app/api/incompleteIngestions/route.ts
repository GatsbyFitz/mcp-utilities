import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { start } from "workflow/api";
import {
  attachRun,
  getIncompleteIngestion,
  isMissingIngestionRunsTable,
  listIncompleteIngestions,
  MISSING_INGESTION_RUNS_MESSAGE,
  toResumePoint,
} from "@/lib/ingestionRuns";
import { resumeIngest } from "../upload/workflow";

/**
 * GET /api/incompleteIngestions — documents that started ingesting and have no
 * `uploads` row yet.
 *
 * This is the durable answer to "what needs finalisation": `ingestion_runs`
 * carries a row from the moment an upload starts, so a refreshed tab, a closed
 * browser or a run whose id was never written down no longer loses track of
 * work the pipeline has already paid for.
 */
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const items = await listIncompleteIngestions();
    return NextResponse.json({ success: true, items });
  } catch (error) {
    if (isMissingIngestionRunsTable(error)) {
      // Not an error state for a database that predates this table: there is
      // simply nothing tracked yet. Say what to run and return an empty list,
      // matching how /api/documentRequests handles its own table.
      return NextResponse.json({
        success: true,
        items: [],
        notice: MISSING_INGESTION_RUNS_MESSAGE,
      });
    }
    console.error("[incompleteIngestions] GET failed:", error);
    return NextResponse.json(
      { success: false, error: "Could not load incomplete ingestions" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/incompleteIngestions  { fileName }
 *
 * Finishes one of them from the Markdown it already has, skipping the Gemini
 * PDF→Markdown parse. Everything the run needs is read from the row rather than
 * taken from the request, so a caller can only name a document, never point the
 * pipeline at a blob of its choosing.
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
    const ingestion = await getIncompleteIngestion(fileName);
    if (!ingestion) {
      return NextResponse.json(
        { success: false, error: "No ingestion is tracked for that document" },
        { status: 404 }
      );
    }

    const resume = toResumePoint(ingestion);
    if (!resume) {
      // Claimed, but the run never got as far as persisting its Markdown, so
      // there is nothing cheaper to restart from than the original PDF.
      return NextResponse.json(
        {
          success: false,
          error:
            "This ingestion stopped before its Markdown was saved, so there is nothing to resume from. Upload the file again.",
        },
        { status: 409 }
      );
    }

    const run = await start(resumeIngest, [resume]);
    await attachRun(resume.fileName, run.runId).catch((error) =>
      console.warn(`[incompleteIngestions] could not attach run to ${resume.fileName}:`, error)
    );

    return NextResponse.json({ success: true, runId: run.runId, fileName: resume.fileName });
  } catch (error) {
    if (isMissingIngestionRunsTable(error)) {
      return NextResponse.json(
        { success: false, error: MISSING_INGESTION_RUNS_MESSAGE },
        { status: 500 }
      );
    }
    console.error("[incompleteIngestions] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Could not finish the ingestion" },
      { status: 500 }
    );
  }
}
