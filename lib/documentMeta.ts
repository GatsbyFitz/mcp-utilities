// ---------------------------------------------------------------------------
// Citation metadata derived from a document's file name.
//
// Used at ingestion (createEmbeddings) and by the backfill route, so an
// existing document ends up with exactly what a freshly ingested one would.
// ---------------------------------------------------------------------------

/** "…-v401.pdf" or "NERR - v30 - Full.pdf" -> "v401" / "v30". */
export function versionFromFilename(fileName: string): string | null {
  const match = fileName.match(/[-_\s]v(\d+(?:\.\d+)*)\b/i);
  return match ? `v${match[1]}` : null;
}

/**
 * Filename fragment -> publisher. Fill this in and re-run
 * POST /api/backfillCitations; new uploads pick it up automatically.
 *
 * There is no heuristic here on purpose. Deriving the publisher from an
 * acronym prefix looks reasonable and is wrong on this very corpus: it reads
 * "AER - Life support registration guide.pdf" correctly, but turns
 * "NERR - v30 - Full.pdf" into publisher "NERR" — the National Energy Retail
 * Rules is the instrument, not its publisher. Nothing in the file name tells
 * the two apart, and a wrong publisher on a regulatory citation is worse than
 * a missing one, so this stays a human-maintained list.
 */
export const PUBLISHERS: Record<string, string> = {
  // "AER - ": "AER",
  // "b2b-procedure": "AEMO",
  // "standing-data-for-msats": "AEMO",
};

/** Publisher for a document, or null when PUBLISHERS does not cover it. */
export function publisherFromFilename(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  for (const [fragment, publisher] of Object.entries(PUBLISHERS)) {
    if (lower.includes(fragment.toLowerCase())) return publisher;
  }
  return null;
}

/** Citation fields that do not vary between the chunks of one document. */
export function documentCitationMeta(fileName: string): {
  version: string | null;
  publisher: string | null;
} {
  return {
    version: versionFromFilename(fileName),
    publisher: publisherFromFilename(fileName),
  };
}
