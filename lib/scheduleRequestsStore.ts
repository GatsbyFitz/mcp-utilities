import { sql } from "@/lib/db";
import type { Schedule } from "@/lib/aerPerformance";
import {
  MAX_PENDING_SCHEDULE_REQUESTS,
  type ScheduleRequest,
  type ScheduleRequestStatus,
} from "@/lib/scheduleRequests";

// ---------------------------------------------------------------------------
// Reading and writing schedule_requests
// ---------------------------------------------------------------------------
// Split from lib/scheduleRequests.ts so the type and the constants can be
// imported without `lib/db` building a Neon client at module load — the same
// reason lib/compliance.ts and lib/complianceStore.ts are two files.
//
// Nothing here catches a missing table. The callers do, because the right
// answer differs: the MCP tool has to tell a model the queue does not exist
// without putting a driver error on a public endpoint, the route returns a 503
// naming the .sql file, and the page renders the same sentence as an empty
// state. See `isMissingScheduleRequestsTable`.

/** snake_case → camelCase at the boundary, per the api-routes rule. */
function toRequest(row: Record<string, unknown>): ScheduleRequest {
  return {
    id: row.id as string,
    schedule: Number(row.schedule) as Schedule,
    periodLabel: row.period_label as string,
    sourceUrl: row.source_url as string,
    note: (row.note as string | null) ?? null,
    requestedBy: (row.requested_by as string | null) ?? null,
    status: row.status as ScheduleRequestStatus,
    statusDetail: (row.status_detail as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null,
    requestedAt: new Date(row.requested_at as string).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string).toISOString() : null,
  };
}

/** The queue, newest first, pending before everything else. */
export async function listScheduleRequests(limit = 100): Promise<ScheduleRequest[]> {
  const rows = await sql`
    SELECT id, schedule, period_label, source_url, note, requested_by,
           status, status_detail, run_id, requested_at, resolved_at
    FROM schedule_requests
    ORDER BY (status = 'pending') DESC, requested_at DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => toRequest(row as Record<string, unknown>));
}

export async function getScheduleRequest(id: string): Promise<ScheduleRequest | null> {
  const rows = await sql`
    SELECT id, schedule, period_label, source_url, note, requested_by,
           status, status_detail, run_id, requested_at, resolved_at
    FROM schedule_requests
    WHERE id = ${id}
  `;
  return rows.length > 0 ? toRequest(rows[0] as Record<string, unknown>) : null;
}

export interface PendingSummary {
  /** Every open request, so a duplicate can be recognised before inserting. */
  pending: { id: string; schedule: Schedule; periodLabel: string }[];
  /** True once the queue is at its cap and should refuse new rows. */
  full: boolean;
}

export async function pendingScheduleRequests(): Promise<PendingSummary> {
  const rows = (await sql`
    SELECT id, schedule, period_label FROM schedule_requests WHERE status = 'pending'
  `) as { id: string; schedule: number; period_label: string }[];

  return {
    pending: rows.map((r) => ({
      id: r.id,
      schedule: Number(r.schedule) as Schedule,
      periodLabel: r.period_label,
    })),
    full: rows.length >= MAX_PENDING_SCHEDULE_REQUESTS,
  };
}

export async function insertScheduleRequest(entry: {
  id: string;
  schedule: Schedule;
  periodLabel: string;
  sourceUrl: string;
  note: string | null;
  requestedBy: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO schedule_requests (id, schedule, period_label, source_url, note, requested_by)
    VALUES (
      ${entry.id}, ${entry.schedule}, ${entry.periodLabel},
      ${entry.sourceUrl}, ${entry.note}, ${entry.requestedBy}
    )
  `;
}

/**
 * Settle a request.
 *
 * `resolved_at` is set for every terminal status including `failed`, so the
 * queue never shows a row as still open when nothing is going to pick it up
 * again. A failed approval keeps its `run_id` — that run is the only place the
 * per-step reason lives, and dropping it would leave "failed" with nothing
 * behind it.
 */
export async function resolveScheduleRequest(
  id: string,
  status: Exclude<ScheduleRequestStatus, "pending">,
  detail: string | null,
  runId: string | null
): Promise<void> {
  await sql`
    UPDATE schedule_requests
    SET status = ${status},
        status_detail = ${detail},
        run_id = COALESCE(${runId}, run_id),
        resolved_at = NOW()
    WHERE id = ${id}
  `;
}
