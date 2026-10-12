// ---------------------------------------------------------------------------
// Reference sources: pages the index points at but never holds
// ---------------------------------------------------------------------------
// A second kind of knowledge, with a different failure mode from the corpus.
//
// Regulatory documents are long, stable, and asked fuzzy questions. They are
// chunked, embedded and cited, and `search_docs` answers from their text.
//
// API documentation is the opposite on the axis that decides it: **stale is
// its worst failure**. A moved endpoint reads exactly like a working one, so
// an indexed copy of the content is a confident lie with a citation attached.
//
// So what is embedded here is not the content — it is a *descriptor*: what the
// page covers and which questions it answers. A descriptor ages far more
// slowly than the page it describes ("documents the NEM Dispatch Bidding API"
// stays true across releases where the endpoint list does not), and the page
// itself is read live by whoever asked.
//
// Pure, importing nothing that builds a client, so a step, a tool, a route and
// a check can all share it. Queries live in lib/referenceStore.ts — the same
// split as lib/compliance.ts vs lib/complianceStore.ts.

/** Marks a vector entry as a reference descriptor rather than a chunk. */
export const REFERENCE_KIND = "reference";

/**
 * `#` rather than a dash, for the reason `figureId` gives: `chunkId` produces
 * `${fileName}-${index}`, so a separator a file name could contain would let
 * one namespace forge another.
 *
 * That is not quite sufficient on its own, and the gap is worth stating. A
 * figure id is `${fileName}#figure-${n}`, so a document named exactly
 * `reference` produces `reference#figure-0` — which a reference named
 * `figure-0` would also produce. Both halves are needed for a collision, and
 * the reference half is the one this code controls, so `reservedReferenceName`
 * refuses it. Nothing in the chunk, figure, process or compliance namespaces
 * can be reached from here.
 *
 * Deliberately no exported id *prefix*: `reference#` is not a safe prefix to
 * scan on, for the reason above. `kind` is the discriminator.
 */
export function referenceId(name: string): string {
  return `reference#${name}`;
}

/**
 * Names that could forge another namespace's id. See `referenceId`.
 *
 * `figure-N` and `process-N` are the only suffixes any other writer puts after
 * a `#`, so refusing them closes the collision completely rather than making
 * it unlikely.
 */
export function reservedReferenceName(name: string): boolean {
  return /^(figure|process)-\d+$/.test(name);
}

export interface ReferenceSource {
  /** Stable key, lower-case and hyphenated. What a URL is addressed by. */
  name: string;
  url: string;
  title: string;
  /**
   * What the page covers and which questions it answers — not its contents.
   * This is what gets embedded, so it is written for matching a question.
   */
  summary: string;
  /**
   * Literal terms a question is likely to use: API names, system names,
   * message types. These carry the sparse side, which is what matches an
   * opaque token like "MSATS" or "aseXML" that dense similarity blurs.
   */
  keyTerms: string[];
  indexedAt: string | null;
}

/** A reference as it comes back from a search, with why it matched. */
export interface ReferenceMatch extends ReferenceSource {
  score: number;
}

export const MAX_REFERENCE_NAME = 80;
export const MAX_REFERENCE_SUMMARY = 2000;
export const MAX_REFERENCE_KEY_TERMS = 40;
/** References returned by one search. A router needs a shortlist, not a page. */
export const MAX_REFERENCE_RESULTS = 5;

/**
 * The key a URL is addressed by.
 *
 * Derived rather than free-form so the same page submitted twice updates in
 * place instead of being indexed under two keys — the `normalizeName` rule
 * for documents, applied to references.
 */
export function normalizeReferenceName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_REFERENCE_NAME);
}

/** A name proposed from a URL, for the submission form's convenience. */
export function nameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.split("/").filter(Boolean).join("-");
    const host = parsed.hostname.replace(/^www\./, "").split(".")[0];
    return normalizeReferenceName(path ? `${host}-${path}` : host);
  } catch {
    return "";
  }
}

/**
 * What gets embedded.
 *
 * Title, summary and key terms, in that order. Deliberately **not** the page's
 * text: the descriptor is matched against a question about what a page covers,
 * and padding it with content would make it match on passages that may no
 * longer be there.
 */
export function descriptorText(source: {
  title: string;
  summary: string;
  keyTerms: string[];
}): string {
  return [source.title, source.summary, source.keyTerms.join(", ")].filter(Boolean).join(" | ");
}

/** A submission that cannot be indexed, or null when it is fine. */
export function referenceProblem(input: {
  url?: string;
  title?: string;
  summary?: string;
}): string | null {
  const url = (input.url ?? "").trim();
  if (!url) return "A URL is required";

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url}" is not a URL`;
  }
  // https only, as everywhere else here. Nothing fetches this server-side, but
  // a reference is handed to a client to open, and an http:// link is one this
  // server should not be recommending.
  if (parsed.protocol !== "https:") return "Only https:// URLs can be referenced";

  if (!(input.title ?? "").trim()) return "A title is required";
  // The summary is the entire basis for matching. A reference without one is
  // an entry that will never be found, which is worse than no entry at all.
  if (!(input.summary ?? "").trim()) {
    return "A summary is required — it is what the question is matched against";
  }
  return null;
}

/** The derived name, checked. Separate because the name is derived after validation. */
export function referenceNameProblem(name: string): string | null {
  if (!name) return "Could not derive a name — supply one";
  if (reservedReferenceName(name)) {
    return `"${name}" is reserved — it would collide with a figure or process id`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The "not provisioned yet" case
// ---------------------------------------------------------------------------

/** The Postgres error raised when the table has never been created. */
export function isMissingReferenceTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /relation .*reference_sources.* does not exist/i.test(message);
}

/**
 * The unique-index violation raised when a URL is already referenced under a
 * different name.
 *
 * Worth recognising rather than reporting as a generic failure: the whole
 * point of the constraint is that one page must have one entry, and someone
 * who hits it needs to be told which entry already exists — not that
 * something went wrong.
 */
export function isDuplicateReferenceUrl(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate key value/i.test(message) && /reference_sources_url_idx/i.test(message);
}

/** Names the file to run. Keep it a path someone can act on directly. */
export const MISSING_REFERENCES_MESSAGE =
  "The reference_sources table does not exist yet — run db/reference_sources.sql against the database.";
