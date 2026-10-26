// Shared vocabulary for the schedule-workbook request queue: the MCP tool that
// creates a request, the route that lists and resolves one, and the card that
// renders the queue. Pure — no `lib/db` import, so a type can be used without
// constructing a Neon client at module load. Queries live in
// lib/scheduleRequestsStore.ts, the same split as compliance and
// aerPerformance.

import type { Schedule } from "@/lib/aerPerformance";

export const SCHEDULE_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "failed",
] as const;

export type ScheduleRequestStatus = (typeof SCHEDULE_REQUEST_STATUSES)[number];

export interface ScheduleRequest {
  id: string;
  schedule: Schedule;
  periodLabel: string;
  sourceUrl: string;
  note: string | null;
  requestedBy: string | null;
  status: ScheduleRequestStatus;
  statusDetail: string | null;
  runId: string | null;
  requestedAt: string;
  resolvedAt: string | null;
}

/**
 * `/mcp` is public, so `submit_schedule` without a credential is an
 * unauthenticated write. These bound what one call can put in the table; the
 * queue cap bounds how many rows can accumulate.
 */
export const MAX_NOTE_LENGTH = 1000;
export const MAX_REQUESTED_BY_LENGTH = 200;
export const MAX_SOURCE_URL_LENGTH = 2000;
/** Refuse new requests past this many pending, rather than grow without limit. */
export const MAX_PENDING_SCHEDULE_REQUESTS = 100;

// ---------------------------------------------------------------------------
// The "not provisioned yet" case
// ---------------------------------------------------------------------------
// `schedule_requests` is created by hand, like every other table here. Until
// someone runs the DDL, every read and write fails, and it fails at the far end
// of the system — inside an MCP tool call, where `relation ... does not exist`
// is something the caller can neither act on nor usefully relay. The tool, the
// route and the page all have to recognise it and say the same thing, so the
// test and the wording live here.

export function isMissingScheduleRequestsTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /relation .*schedule_requests.* does not exist/i.test(message);
}

/** Names the file to run. Keep it a path someone can act on directly. */
export const MISSING_SCHEDULE_REQUESTS_MESSAGE =
  "The schedule_requests table does not exist yet — run db/schedule_requests.sql against the database.";

/**
 * The unique index on pending (schedule, period) firing.
 *
 * The tool checks for an existing pending request before inserting, but two
 * clients asking for the same workbook at once both pass that check and the
 * database settles it. The loser must be told it is already queued — not shown
 * a constraint name from a public endpoint.
 */
export function isDuplicatePendingSchedule(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /duplicate key value/i.test(message) && /schedule_requests_pending_idx/i.test(message)
  );
}

/** How a workbook is named in prose, for a message a person reads. */
export function describeWorkbook(schedule: Schedule | number, periodLabel: string): string {
  return `Schedule ${schedule}, ${periodLabel}`;
}
