import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { start } from "workflow/api";
import { SCHEDULES, normalizePeriodLabel, periodBounds, type Schedule } from "@/lib/aerPerformance";
import {
  DocumentFetchError,
  SPREADSHEET_KIND,
  downloadToBlob,
  fileNameFromUrl,
} from "@/lib/fetchDocument";
import {
  MISSING_SCHEDULE_REQUESTS_MESSAGE,
  isMissingScheduleRequestsTable,
} from "@/lib/scheduleRequests";
import {
  getScheduleRequest,
  listScheduleRequests,
  resolveScheduleRequest,
} from "@/lib/scheduleRequestsStore";
import { ingestSchedule } from "../ingestSchedule/workflow";

// Fetches the workbook from aer.gov.au, which refuses US-region traffic, so
// this deployment must run in an Australian region — a project-level setting,
// not something a route can ask for. See app/mcp/route.ts for the measurement
// and for why `preferredRegion` here does not work.

/**
 * The review queue behind the MCP `submit_schedule` tool.
 *
 * GET  — every request, pending first.
 * POST — `{ id, action: "approve" | "reject", url?, schedule?, periodLabel? }`.
 *
 * Approval is the only thing that ever fetches a queued URL. `submit_schedule`
 * without a credential is unauthenticated, so until a signed-in operator
 * presses approve the URL is a string in a table and nothing more — the same
 * contract `documentRequests` has, and the reason that tool does not fetch.
 *
 * The operator may correct the schedule and period on approval. They are the
 * identity of the workbook, they were typed by whoever submitted it, and a
 * quarter stored under the wrong label is wrong in a way no later query can
 * detect — so the last person to look at it gets the final say.
 */

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json({ success: true, items: await listScheduleRequests() });
  } catch (error) {
    if (isMissingScheduleRequestsTable(error)) {
      // Not an error for a deployment that has never used the tool — an empty
      // queue and the file to run, rather than a red banner.
      return NextResponse.json({
        success: true,
        items: [],
        notice: MISSING_SCHEDULE_REQUESTS_MESSAGE,
      });
    }
    console.error("[scheduleRequests] GET failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to read schedule requests" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    action?: string;
    url?: string;
    schedule?: number;
    periodLabel?: string;
  };

  if (!body.id || (body.action !== "approve" && body.action !== "reject")) {
    return NextResponse.json(
      { success: false, error: 'Supply an id and action of "approve" or "reject"' },
      { status: 400 }
    );
  }

  try {
    const request = await getScheduleRequest(body.id);
    if (!request) {
      return NextResponse.json({ success: false, error: "No such request" }, { status: 404 });
    }
    if (request.status !== "pending") {
      return NextResponse.json(
        { success: false, error: `That request is already ${request.status}` },
        { status: 409 }
      );
    }

    if (body.action === "reject") {
      await resolveScheduleRequest(request.id, "rejected", null, null);
      return NextResponse.json({ success: true, id: request.id, status: "rejected" });
    }

    // The operator's values win over the submitter's, which were only the
    // defaults they saw before pressing approve.
    const schedule = Number(body.schedule ?? request.schedule);
    if (!SCHEDULES.includes(schedule as Schedule)) {
      return NextResponse.json(
        { success: false, error: `schedule must be one of ${SCHEDULES.join(", ")}` },
        { status: 400 }
      );
    }

    const rawPeriod = (body.periodLabel ?? request.periodLabel).trim();
    const periodLabel = normalizePeriodLabel(rawPeriod) ?? rawPeriod;
    // Re-validated on approval rather than trusted from the row: the tool
    // checks it too, but that check ran against an unauthenticated caller's
    // input and this is the point where it becomes a database write.
    if (!periodBounds(periodLabel)) {
      return NextResponse.json(
        {
          success: false,
          error: `Could not read a period from "${rawPeriod}". Expected something like "2023-24 Q3".`,
        },
        { status: 400 }
      );
    }

    const target = (body.url ?? request.sourceUrl).trim();
    if (!target) {
      return NextResponse.json(
        { success: false, error: "This request has no URL — supply one to approve it" },
        { status: 400 }
      );
    }

    let blobUrl: string;
    let fileName: string;
    try {
      fileName = fileNameFromUrl(
        target,
        `schedule-${schedule}-${periodLabel}`,
        SPREADSHEET_KIND
      );
      const fetched = await downloadToBlob(target, fileName, SPREADSHEET_KIND);
      blobUrl = fetched.url;
      fileName = fetched.fileName;
    } catch (error) {
      // A refusal names what was wrong with the source and is safe to show —
      // it is a URL the operator just looked at. Anything else is logged and
      // reported generically, per the api-routes rule.
      const detail =
        error instanceof DocumentFetchError ? error.message : "Could not fetch the workbook";
      if (!(error instanceof DocumentFetchError)) {
        console.error("[scheduleRequests] fetch failed:", error);
      }
      await resolveScheduleRequest(request.id, "failed", detail, null);
      return NextResponse.json({ success: false, error: detail }, { status: 400 });
    }

    const run = await start(ingestSchedule, [
      { schedule: schedule as Schedule, periodLabel, blobUrl, fileName },
    ]);

    await resolveScheduleRequest(request.id, "approved", null, run.runId);

    // Shaped like POST /api/ingestSchedule's response so the page hands it to
    // the same progress tracker a browser upload uses.
    return NextResponse.json({
      success: true,
      id: request.id,
      status: "approved",
      schedule,
      periodLabel,
      runs: [{ fileName, runId: run.runId }],
    });
  } catch (error) {
    if (isMissingScheduleRequestsTable(error)) {
      return NextResponse.json(
        { success: false, error: MISSING_SCHEDULE_REQUESTS_MESSAGE },
        { status: 500 }
      );
    }
    console.error("[scheduleRequests] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to resolve the schedule request" },
      { status: 500 }
    );
  }
}
