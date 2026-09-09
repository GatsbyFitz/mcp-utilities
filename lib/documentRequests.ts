// Shared vocabulary for the document request queue: the MCP tool that creates
// a request, the route that lists and resolves one, and the page that renders
// the queue.

export const REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "failed",
] as const;

export type DocumentRequestStatus = (typeof REQUEST_STATUSES)[number];

export interface DocumentRequest {
  id: string;
  title: string;
  reason: string | null;
  sourceUrl: string | null;
  requestedBy: string | null;
  status: DocumentRequestStatus;
  statusDetail: string | null;
  runId: string | null;
  requestedAt: string;
  resolvedAt: string | null;
}

/** Matches `uploads` name comparison so a request can be checked against it. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * `/mcp` is public, so `request_document` is an unauthenticated write. These
 * bound what one call can put in the table; the queue cap in the tool bounds
 * how many rows can accumulate.
 */
export const MAX_TITLE_LENGTH = 300;
export const MAX_REASON_LENGTH = 1000;
export const MAX_URL_LENGTH = 2000;
/** Refuse new requests past this many pending, rather than grow without limit. */
export const MAX_PENDING_REQUESTS = 200;

// ---------------------------------------------------------------------------
// The "not provisioned yet" case
// ---------------------------------------------------------------------------
// `document_requests` is created by hand, like `uploads` and the Neo4j
// `entity_names` index — see .claude/conventions/data-stores.md. Until someone
// runs the DDL, every read and write fails, and the failure surfaces at the far
// end of the system: inside an MCP tool call, where the cause is anything but
// obvious. Both the route and the tool have to recognise it and say the same
// thing, so the test and the wording live here rather than in either of them.

/** The Postgres error raised when the table has never been created. */
export function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /relation .*document_requests.* does not exist/i.test(message);
}

/** Names the file to run. Keep it a path someone can act on directly. */
export const MISSING_TABLE_MESSAGE =
  "The document_requests table does not exist yet — run db/document_requests.sql against the database.";
