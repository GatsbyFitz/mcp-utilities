import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { start } from "workflow/api";
import { SCHEDULES, type Schedule } from "@/lib/aerPerformance";
import {
  EARLIEST_FY_START,
  MAX_BACKFILL_TARGETS,
  discoveryTargets,
  quarterLabelsBetween,
} from "@/lib/aerReleases";
import { backfillSchedules } from "../backfill";

/**
 * POST /api/ingestSchedule/bulk — back-fill many quarters at once.
 *
 * `{ fromFyStart?, toFyStart?, schedules?, dryRun? }`. Defaults to every
 * financial year the AER has published these schedules for, and all three
 * schedules.
 *
 * The single-quarter route stays the primary one: the schedule number and
 * period are supplied there because they are on the release page and not
 * reliably inside the file. This route derives them instead, which is only
 * safe because it derives them from the page URL it found the file on — the
 * same pairing, read rather than typed.
 *
 * `dryRun` returns the targets without fetching anything. Worth having:
 * running this for real costs a model call and a database write per workbook
 * across ninety of them, and the first question is always "which quarters do
 * you think exist".
 */
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    fromFyStart?: number;
    toFyStart?: number;
    schedules?: number[];
    dryRun?: boolean;
  };

  const now = new Date();
  // The Australian financial year starts in July, so months before then still
  // belong to the year before.
  const currentFyStart = now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;

  const fromFyStart = Number.isFinite(body.fromFyStart)
    ? Number(body.fromFyStart)
    : EARLIEST_FY_START;
  const toFyStart = Number.isFinite(body.toFyStart) ? Number(body.toFyStart) : currentFyStart;

  if (fromFyStart < 2000 || toFyStart > currentFyStart + 1 || fromFyStart > toFyStart) {
    return NextResponse.json(
      {
        success: false,
        error:
          `fromFyStart/toFyStart must be a sane financial-year range ` +
          `(${EARLIEST_FY_START}–${currentFyStart}); got ${fromFyStart}–${toFyStart}`,
      },
      { status: 400 }
    );
  }

  const schedules = (
    Array.isArray(body.schedules) && body.schedules.length
      ? body.schedules.map(Number)
      : [...SCHEDULES]
  ).filter((s): s is Schedule => SCHEDULES.includes(s as Schedule));

  if (schedules.length === 0) {
    return NextResponse.json(
      { success: false, error: `schedules must be a subset of ${SCHEDULES.join(", ")}` },
      { status: 400 }
    );
  }

  // `now` so a quarter that has not finished yet is never requested.
  const labels = quarterLabelsBetween(fromFyStart, toFyStart, now);
  const targets = discoveryTargets(labels, schedules);

  // Bounded because every target is a request to someone else's server, and a
  // mistyped range should not become thousands of them.
  if (targets.length > MAX_BACKFILL_TARGETS) {
    return NextResponse.json(
      {
        success: false,
        error:
          `${targets.length} targets exceeds the ${MAX_BACKFILL_TARGETS} cap. ` +
          `Narrow the year range or the schedule list.`,
      },
      { status: 400 }
    );
  }

  if (body.dryRun) {
    return NextResponse.json({
      success: true,
      dryRun: true,
      fromFyStart,
      toFyStart,
      schedules,
      targets: targets.length,
      quarters: labels,
      // Every candidate, not the likeliest one: a dry run exists to show what
      // the real run would fetch, and it would fetch the second slug form
      // wherever the first 404s.
      pages: targets.flatMap((t) => t.pageUrls),
    });
  }

  try {
    const run = await start(backfillSchedules, [{ labels, schedules }]);
    return NextResponse.json({
      success: true,
      fromFyStart,
      toFyStart,
      schedules,
      targets: targets.length,
      runs: [{ fileName: `AER backfill ${fromFyStart}–${toFyStart}`, runId: run.runId }],
    });
  } catch (error) {
    console.error("[ingestSchedule/bulk] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to start the backfill" },
      { status: 500 }
    );
  }
}
