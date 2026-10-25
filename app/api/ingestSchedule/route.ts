import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { start } from "workflow/api";
import { SCHEDULES, periodBounds, type Schedule } from "@/lib/aerPerformance";
import {
  DocumentFetchError,
  SPREADSHEET_KIND,
  downloadToBlob,
  fileNameFromUrl,
} from "@/lib/fetchDocument";
import { ingestSchedule } from "./workflow";

/**
 * POST /api/ingestSchedule — ingest one AER retail performance workbook.
 *
 * `{ schedule, periodLabel, blobUrl, fileName }`. The browser uploads the file
 * to Blob first and posts the manifest, as every other upload here does: a
 * Vercel function caps its request body at 4.5 MB and these workbooks run to
 * several, so bytes never pass through a handler.
 * See .claude/conventions/file-uploads.md.
 *
 * `{ schedule, periodLabel, sourceUrl }` is the other way in: the AER links
 * each workbook from its release page, so the server fetches it rather than
 * asking someone to download and re-upload it. That goes through
 * `downloadToBlob`, which validates the *resolved* address on every redirect
 * hop — a server-side fetch of a supplied URL runs from inside the deployment,
 * where it can reach metadata endpoints. Never write a second fetcher for it.
 *
 * The schedule number and the period are supplied rather than guessed. They
 * are on the AER's release page, not reliably inside the file, and guessing
 * them wrong files a whole quarter under the wrong label — which no later
 * query could detect.
 */
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    schedule?: number;
    periodLabel?: string;
    blobUrl?: string;
    fileName?: string;
    sourceUrl?: string;
  };

  const schedule = Number(body.schedule);
  if (!SCHEDULES.includes(schedule as Schedule)) {
    return NextResponse.json(
      { success: false, error: `schedule must be one of ${SCHEDULES.join(", ")}` },
      { status: 400 }
    );
  }

  const periodLabel = (body.periodLabel ?? "").trim();
  // Checked here rather than deep in the workflow: an unparseable period is a
  // typo to correct now, not a run to start and have fail three steps later.
  if (!periodBounds(periodLabel)) {
    return NextResponse.json(
      {
        success: false,
        error: `Could not read a period from "${periodLabel}". Expected something like "2023-24 Q3".`,
      },
      { status: 400 }
    );
  }

  const sourceUrl = (body.sourceUrl ?? "").trim();
  if (!sourceUrl && (!body.blobUrl || !body.fileName)) {
    return NextResponse.json(
      { success: false, error: "Either sourceUrl, or blobUrl and fileName, are required" },
      { status: 400 }
    );
  }

  let blobUrl = body.blobUrl ?? "";
  let fileName = (body.fileName ?? "").trim();

  if (sourceUrl) {
    try {
      fileName =
        fileName ||
        fileNameFromUrl(sourceUrl, `schedule-${schedule}-${periodLabel}`, SPREADSHEET_KIND);
      const fetched = await downloadToBlob(sourceUrl, fileName, SPREADSHEET_KIND);
      blobUrl = fetched.url;
      fileName = fetched.fileName;
    } catch (error) {
      // A refusal names what was wrong with the source and is safe to show —
      // it is the operator's own URL being reported back. Anything else is
      // logged and reported generically, per the api-routes rule.
      const detail =
        error instanceof DocumentFetchError ? error.message : "Could not fetch the workbook";
      if (!(error instanceof DocumentFetchError)) {
        console.error("[ingestSchedule] fetch failed:", error);
      }
      return NextResponse.json({ success: false, error: detail }, { status: 400 });
    }
  }

  try {
    const run = await start(ingestSchedule, [
      { schedule: schedule as Schedule, periodLabel, blobUrl, fileName },
    ]);

    return NextResponse.json({
      success: true,
      runs: [{ fileName, runId: run.runId }],
    });
  } catch (error) {
    console.error("[ingestSchedule] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to queue the schedule ingest" },
      { status: 500 }
    );
  }
}
