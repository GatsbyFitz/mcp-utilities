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
