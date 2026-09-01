// ---------------------------------------------------------------------------
// Shared chunking
// ---------------------------------------------------------------------------
// The embedding step and the graph-extraction step must agree byte-for-byte on
// chunk boundaries and IDs: search_graph stores a chunkId on every relationship
// and later feeds it straight to vectorIndex.fetch(). If the two steps chunked
// independently and drifted, every graph hit would fetch a missing or wrong
// excerpt. One implementation, imported by both.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root } from "mdast";

/**
 * Page-break marker emitted by `createMarkdown`, sitting immediately before
 * the content of the page it names (1-indexed). Content before the first
 * marker is page 1.
 *
 * Markers are stripped before parsing, never chunked: they would otherwise be
 * embedded, fed to the model as context, and shown inside citation excerpts —
 * and a marker landing mid-table would break the table for the AST parser.
 */
const PAGE_MARKER = /^[ \t]*-{4,}\s*Page \((\d+)\) Break\s*-{4,}[ \t]*$/gm;

interface PageBreak {
  /** Offset into the *stripped* text at which this page's content begins. */
  offset: number;
  page: number;
}

/**
 * Removes page markers and records where each page starts in the stripped
 * text. A document with no markers comes back unchanged with no breaks, so
 * chunk boundaries for documents ingested before markers existed are
 * bit-for-bit what they always were.
 */
export function stripPageMarkers(text: string): { text: string; breaks: PageBreak[] } {
  const breaks: PageBreak[] = [];
  let stripped = "";
  let lastIndex = 0;

  PAGE_MARKER.lastIndex = 0;
  for (const match of text.matchAll(PAGE_MARKER)) {
    const start = match.index!;
    stripped += text.slice(lastIndex, start);
    breaks.push({ offset: stripped.length, page: parseInt(match[1], 10) });
    lastIndex = start + match[0].length;
  }
  stripped += text.slice(lastIndex);

  return { text: stripped, breaks };
}

/** The 1-indexed page in effect at an offset into the stripped text. */
function pageAt(breaks: PageBreak[], offset: number): number {
  let page = 1;
  for (const brk of breaks) {
    if (brk.offset > offset) break;
    page = brk.page;
  }
  return page;
}

/** Canonical vector-index ID for a chunk. */
export function chunkId(fileName: string, index: number): string {
  return `${fileName}-${index}`;
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Plain word-count split, used only as a fallback for a single block too large to keep whole. */
function splitBySize(text: string, size: number): string[] {
  const words = text.split(/\s+/);
  const parts: string[] = [];
  for (let i = 0; i < words.length; i += size) {
    parts.push(words.slice(i, i + size).join(" "));
  }
  return parts;
}

/**
 * Structure-aware chunking: splits along Markdown block boundaries (headings,
 * paragraphs, tables, lists, ...) rather than a blind word count, so a table
 * or paragraph is never cut mid-block. Blocks are packed greedily up to
 * `size` words; a heading always starts a new chunk so each chunk carries its
 * own heading context. A table is never split internally — even if it alone
 * exceeds `size`, splitting it would change what it means — but any other
 * single block that alone exceeds `size` falls back to a plain word-count
 * split, since there's no smaller structural boundary to use instead. A
 * heading with nothing under it yet always rides along with whatever follows
 * — including an oversized block — rather than being flushed alone; a
 * heading isolated from its own content is worse than one oversized chunk.
 */
export interface Chunk {
  text: string;
  /** 1-indexed printed page the chunk starts on; null when the document has no page markers. */
  pageStart: number | null;
  /** 1-indexed printed page the chunk ends on; null when the document has no page markers. */
  pageEnd: number | null;
}

/**
 * Same boundaries as `chunkText`, plus the page span each chunk covers.
 * `chunkText` delegates here, so every caller chunks identically whether or
 * not it cares about pages — the invariant above depends on that.
 */
export function chunkTextWithPages(raw: string, size = 500): Chunk[] {
  const { text, breaks } = stripPageMarkers(raw);
  const tree = markdownParser.parse(text) as Root;

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentWords = 0;
  let currentHasBody = false;
  let currentStart: number | null = null;
  let currentEnd: number | null = null;

  function push(body: string, start: number | null, end: number | null) {
    chunks.push({
      text: body,
      pageStart: breaks.length > 0 && start !== null ? pageAt(breaks, start) : null,
      pageEnd: breaks.length > 0 && end !== null ? pageAt(breaks, Math.max(start ?? 0, end - 1)) : null,
    });
  }

  function flush() {
    if (current.length > 0) {
      push(current.join("\n\n").trim(), currentStart, currentEnd);
      current = [];
      currentWords = 0;
      currentHasBody = false;
      currentStart = null;
      currentEnd = null;
    }
  }

  for (const node of tree.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;

    const blockText = text.slice(start, end);
    const words = wordCount(blockText);
    const isHeading = node.type === "heading";
    const isTable = node.type === "table";

    // A heading starts a new chunk once the current one has body content;
    // consecutive headings with nothing between them stay together instead
    // of leaving the first one isolated.
    if (isHeading && currentHasBody) flush();

    if (!isTable && words > size) {
      // No smaller structural boundary to split on than the word count. A
      // pending heading rides along with the first piece rather than being
      // flushed alone.
      // One block split by word count has no finer offsets to attribute, so
      // every part reports the whole block's page span.
      const parts = splitBySize(blockText, size);
      current.push(parts[0]);
      push(current.join("\n\n").trim(), currentStart ?? start, end);
      for (const part of parts.slice(1)) push(part, start, end);
      current = [];
      currentWords = 0;
      currentHasBody = false;
      currentStart = null;
      currentEnd = null;
      continue;
    }

    // Adding this block would overflow the chunk in progress — start fresh,
    // unless all that's pending is a heading with no body yet, in which case
    // let it ride along even if the combined chunk exceeds `size`.
    if (currentHasBody && currentWords + words > size) {
      flush();
    }

    // Claimed only now: any flush above has already closed the previous chunk
    // with its own range.
    if (currentStart === null) currentStart = start;
    currentEnd = end;

    current.push(blockText);
    currentWords += words;
    if (!isHeading) currentHasBody = true;
  }

  flush();
  return chunks;
}

/** Chunk bodies only — the shape the contextualisation and graph steps use. */
export function chunkText(text: string, size = 500): string[] {
  return chunkTextWithPages(text, size).map((chunk) => chunk.text);
}

export function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.(pdf|docx?|txt|md)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function extractTitle(markdown: string, filename: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : titleFromFilename(filename);
}
