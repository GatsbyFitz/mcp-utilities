// ---------------------------------------------------------------------------
// Regulatory enforcement actions, from the Notion Compliance Tracker
// ---------------------------------------------------------------------------
// These reach all three retrieval surfaces, because each answers something the
// others cannot: `search_docs` finds an action by what it was about,
// `search_graph` walks who was penalised by whom for what, and
// `search_compliance` — reading this table — answers the questions that need
// *every* matching row and arithmetic over them.
//
// That last one is why the rows live in Postgres rather than only in the
// vector index. "How many times has ENGIE been fined" cannot be answered by
// top-k similarity: it cannot promise it has them all, and it cannot add up.
// On compliance questions a quietly incomplete answer is worse than none.

export interface ComplianceAction {
  pageId: string;
  summary: string;
  organisation: string | null;
  sector: string | null;
  /** ISO date of the action itself, not of the sync. */
  actionDate: string | null;
  regulator: string | null;
  status: string | null;
  /** Null where no fine applies — an open investigation has none, which is not zero. */
  fine: number | null;
  /** The regulator's own page for the action; what a citation links to. */
  sourceUrl: string | null;
  misconductTypes: string[];
}

/**
 * Vector-index id for an action.
 *
 * Its own namespace, exactly as `figureId` has one, and for the same reason:
 * no document chunk id moves, so the chunking invariant holds and every
 * `chunkId` already stored on a Neo4j relationship keeps resolving. Compliance
 * rows are additive to the corpus, never a re-index of it.
 */
export function complianceId(pageId: string): string {
  return `compliance#${pageId}`;
}

/** Marks a vector entry as an enforcement action rather than a chunk or figure. */
export const COMPLIANCE_KIND = "compliance";

/**
 * `sourceDoc` on every compliance graph edge.
 *
 * `replaceDocumentGraph` deletes edges by `sourceDoc`, so a distinct value
 * scopes a re-sync to exactly these and leaves document-derived edges alone.
 */
export const COMPLIANCE_SOURCE_DOC = "Compliance Tracker";

// ---------------------------------------------------------------------------
// The "not provisioned yet" case
// ---------------------------------------------------------------------------

/** The Postgres error raised when the table has never been created. */
export function isMissingComplianceTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /relation .*compliance_actions.* does not exist/i.test(message);
}

/** Names the file to run. Keep it a path someone can act on directly. */
export const MISSING_COMPLIANCE_MESSAGE =
  "The compliance_actions table does not exist yet — run db/compliance_actions.sql against the database.";
