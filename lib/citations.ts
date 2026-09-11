
interface ChunkMetadata {
  text?: string;
  source?: string;
  chunkIndex?: number;
  citationId?: string;
  blobUrl?: string;
  blobDownloadUrl?: string;
  // Written by createEmbeddings; null on documents ingested before the
  // relevant derivation existed, and backfillable — see /api/backfillCitations.
  pageStart?: number | null;
  pageEnd?: number | null;
  title?: string;
  version?: string;
  publisher?: string;
  effectiveDate?: string;
  /** "figure" on an entry cropped from a page; absent on a text chunk. */
  kind?: string;
  /** Public URL of the figure PNG. Present only when `kind` is "figure". */
  imageUrl?: string;
  /**
   * Smaller copy of the same figure, for returning inline in a tool response.
   * Absent on figures extracted before it existed, which fall back to
   * `imageUrl` — correct, just more expensive.
   */
  inlineImageUrl?: string;
}

interface Citation {
  title: string;
  version: string | null;
  publisher: string | null;
  pages: string | null;
  /**
   * The first page, unformatted, for building a `#page=N` anchor.
   *
   * `pages` is prose ("pp. 10-11") and cannot be turned back into a number, so
   * both are kept. Null on a document ingested before page markers existed.
   */
  pageStart: number | null;
  url: string | null;
  source: string;
  chunkIndex: number | null;
  /** Set when this result is a figure rather than an excerpt of prose. */
  imageUrl: string | null;
  /** The copy to send inline; falls back to `imageUrl` where none was stored. */
  inlineImageUrl: string | null;
}

/** "service-level-procedure-mp-services-v20.pdf" -> "Service Level Procedure Mp Services V20" */
function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.(pdf|docx?|txt|md)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "p. 4" / "pp. 4\u20136" from the page span stored at ingestion. */
function pageRange(start?: number | null, end?: number | null): string | null {
  if (!start) return null;
  if (!end || end <= start) return `p. ${start}`;
  return `pp. ${start}\u2013${end}`;
}

function toCitation(md: ChunkMetadata): Citation {
  return {
    title: md.title ?? titleFromFilename(md.source ?? "unknown"),
    version: md.version ?? null,
    publisher: md.publisher ?? null,
    pages: pageRange(md.pageStart, md.pageEnd),
    pageStart: md.pageStart ?? null,
    url: md.blobUrl ?? null,
    source: md.source ?? "unknown",
    chunkIndex: md.chunkIndex ?? null,
    imageUrl: md.imageUrl ?? null,
    inlineImageUrl: md.inlineImageUrl ?? md.imageUrl ?? null,
  };
}

/**
 * "Title v4.0.1" — how a document is named wherever it is referred to as a
 * whole, as opposed to one chunk of it.
 *
 * `version` is stored already prefixed ("v401", from lib/documentMeta.ts), so
 * it is used verbatim rather than re-prefixed.
 */
function citationLabel(c: Citation): string {
  return c.version ? `${c.title} ${c.version}` : c.title;
}

/** "[1] Title v4.0.1 (pp. 10-11) — relevance 0.74" */
function citationLine(n: number, c: Citation, score: number): string {
  const detail = c.pages ? ` (${c.pages})` : "";
  return `[${n}] ${citationLabel(c)}${detail} \u2014 relevance ${score.toFixed(2)}`;
}

/**
 * The block under a figure result: the image, then links to it and to the page
 * it was cropped from.
 *
 * ```
 * ![B2B Procedure v3.2 (p. 64)](https://…/figures/….png)
 * [Open figure](https://…/figures/….png) · [Source page 64](https://…/uploads/….pdf#page=64)
 * ```
 *
 * The image embed alone was not enough, which is the whole reason this is a
 * block rather than a line. `![…](…)` is not a *link* in most renderers — it
 * produces a picture with no way to reach the file — and `sourceList` dedupes
 * by document, so a figure's own URL appeared nowhere else in the response. A
 * client that strips tool-result Markdown, or a model that describes the
 * figure instead of quoting it, therefore left the reader with no route to it
 * at all. A plain Markdown link survives both: it is text, and it is the one
 * form a model reliably carries into its answer.
 *
 * Both destinations are offered because they answer different questions. The
 * PNG is the cropped diagram itself; the PDF anchor is where it came from, and
 * in a regulatory corpus provenance is not optional.
 *
 * Returns null for a text chunk, so callers can emit it unconditionally.
 */
function figureLine(c: Citation): string | null {
  if (!c.imageUrl) return null;

  const detail = c.pages ? ` (${c.pages})` : "";
  const label = escapeLinkLabel(`${citationLabel(c)}${detail}`);
  const image = linkDestination(c.imageUrl);

  const links = [`[Open figure](${image})`];

  // `url` is served inline; `blobDownloadUrl` forces a download and would
  // defeat the anchor. Omitted entirely when the page is unknown rather than
  // emitting `#page=null` — a document ingested before page markers existed
  // has no page to point at.
  if (c.url && c.pageStart !== null) {
    links.push(`[Source page ${c.pageStart}](${linkDestination(`${c.url}#page=${c.pageStart}`)})`);
  }

  return `![${label}](${image})\n${links.join(" · ")}`;
}

/** Markdown link text is delimited by brackets, so a title containing one would break it. */
function escapeLinkLabel(label: string): string {
  return label.replace(/([[\]])/g, "\\$1");
}

/**
 * A bare URL only survives as a link if it has no whitespace or parentheses;
 * the angle-bracket form is the CommonMark escape hatch for the rest. Blob
 * pathnames embed the original file name, so parentheses do occur.
 */
function linkDestination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/([<>])/g, "\\$1")}>` : url;
}

/**
 * Deduplicated source list, one line per document, as Markdown links.
 *
 * Emitted as links rather than "Title: https://…" so the block is already
 * clickable when a model quotes the tool output verbatim — which is the common
 * case. Relying on the model to pair a title with a bare URL and rebuild the
 * link itself gets it wrong often enough to matter. Every tool that cites
 * documents should render its sources through this, so the format stays
 * identical across them.
 */
function sourceList(citations: Citation[]): string {
  const unique = [...new Map(citations.map((c) => [c.source, c])).values()];

  return unique
    .map((c) => {
      const label = escapeLinkLabel(citationLabel(c));
      return c.url ? `- [${label}](${linkDestination(c.url)})` : `- ${label} (no URL in index)`;
    })
    .join("\n");
}

export type { ChunkMetadata, Citation };
export { toCitation, citationLine, citationLabel, figureLine, sourceList };