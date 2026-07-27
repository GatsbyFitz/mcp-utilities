
interface ChunkMetadata {
  text?: string;
  source?: string;
  chunkIndex?: number;
  citationId?: string;
  blobUrl?: string;
  blobDownloadUrl?: string;
  // Present if you enrich at ingestion (recommended):
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

/** Extract page range from "----------------Page (N) Break----------------" markers in chunk text. */
function pageRange(text: string): string | null {
  const pages = [...text.matchAll(/Page \((\d+)\) Break/g)].map((m) =>
    parseInt(m[1], 10)
  );
  if (pages.length === 0) return null;
  const min = Math.min(...pages);
  const max = Math.max(...pages);
  // Page markers are 0-indexed breaks; content spans from before the first
  // marker to after the last, so report as printed pages (1-indexed).
  return min === max ? `p. ${min + 1}` : `pp. ${min + 1}\u2013${max + 2}`;
}

function toCitation(md: ChunkMetadata): Citation {
  return {
    title: md.title ?? titleFromFilename(md.source ?? "unknown"),
    version: md.version ?? null,
    publisher: md.publisher ?? null,
    pages: md.text ? pageRange(md.text) : null,
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