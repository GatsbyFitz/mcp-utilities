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

/**
 * The unique index on pending titles firing.
 *
 * The tool checks for an existing pending request before inserting, but two
 * clients asking for the same document at once both pass that check and the
 * database settles it. The loser must be told it is already queued — not shown
 * a constraint name from a public endpoint.
 */
export function isDuplicatePendingRequest(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate key value/i.test(message) && /document_requests_pending_title_idx/i.test(message);
}

/** Names the file to run. Keep it a path someone can act on directly. */
export const MISSING_TABLE_MESSAGE =
  "The document_requests table does not exist yet — run db/document_requests.sql against the database.";

// ---------------------------------------------------------------------------
// Is this document already indexed?
// ---------------------------------------------------------------------------
// The hard case is that a request carries a *prose title* ("B2B Procedure:
// Technical Delivery Specification") while the knowledge base stores a *file
// name* ("B2B-Procedure-Technical-Delivery-Spec-v3.2.pdf"). A substring match
// between those two never fires — punctuation, hyphens, abbreviations and a
// version suffix all differ — so comparing them needs tokens, not `LIKE`.

/** Version-ish tokens, dropped so "v3" or "v32" never carries a match. */
const VERSION_TOKEN = /^v?\d+(\.\d+)*$/;

/** Too common in this corpus to be evidence of anything. */
const STOP_TOKENS = new Set(["the", "and", "for", "of", "a", "an", "to", "procedure", "document", "full", "final", "draft"]);

/**
 * Comparable tokens from a title or a file name: extension removed, anything
 * non-alphanumeric treated as a separator, versions and filler dropped.
 */
export function titleTokens(value: string): string[] {
  return value
    .replace(/\.(pdf|docx?|txt|md)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !VERSION_TOKEN.test(t) && !STOP_TOKENS.has(t));
}

export interface IndexedMatch {
  name: string;
  /** Share of the requested title's tokens present in this document's name. */
  coverage: number;
}

/**
 * Indexed documents that plausibly *are* the requested one, best first.
 *
 * Scored by how much of the request the document's name accounts for, not by
 * similarity in both directions: a file name carries extra tokens (version,
 * publisher, "full") that the request has no reason to include, and penalising
 * those would hide real matches.
 */
export function matchIndexedDocuments(
  title: string,
  names: string[],
  threshold = 0.6
): IndexedMatch[] {
  const wanted = titleTokens(title);
  if (wanted.length === 0) return [];

  return names
    .map((name) => {
      const have = new Set(titleTokens(name));
      const hits = wanted.filter((t) => have.has(t)).length;
      return { name, coverage: hits / wanted.length };
    })
    .filter((m) => m.coverage >= threshold)
    .sort((a, b) => b.coverage - a.coverage);
}
