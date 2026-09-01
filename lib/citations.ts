
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
}

interface Citation {
  title: string;
  version: string | null;
  publisher: string | null;
  pages: string | null;
  url: string | null;
  source: string;
  chunkIndex: number | null;
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
    url: md.blobUrl ?? null,
    source: md.source ?? "unknown",
    chunkIndex: md.chunkIndex ?? null,
  };
}

/** "[1] Title (v2.0, pp. 10-11) — score 0.74" */
function citationLine(n: number, c: Citation, score: number): string {
  const parts = [c.version ? `v${c.version}` : null, c.pages].filter(Boolean);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  return `[${n}] ${c.title}${detail} \u2014 relevance ${score.toFixed(2)}`;
}

export type { ChunkMetadata, Citation };
export { toCitation, citationLine };