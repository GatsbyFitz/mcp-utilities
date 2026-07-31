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
export function chunkText(text: string, size = 500): string[] {
  const tree = markdownParser.parse(text) as Root;

  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;
  let currentHasBody = false;

  function flush() {
    if (current.length > 0) {
      chunks.push(current.join("\n\n").trim());
      current = [];
      currentWords = 0;
      currentHasBody = false;
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
      const parts = splitBySize(blockText, size);
      current.push(parts[0]);
      chunks.push(current.join("\n\n").trim());
      chunks.push(...parts.slice(1));
      current = [];
      currentWords = 0;
      currentHasBody = false;
      continue;
    }

    // Adding this block would overflow the chunk in progress — start fresh,
    // unless all that's pending is a heading with no body yet, in which case
    // let it ride along even if the combined chunk exceeds `size`.
    if (currentHasBody && currentWords + words > size) {
      flush();
    }

    current.push(blockText);
    currentWords += words;
    if (!isHeading) currentHasBody = true;
  }

  flush();
  return chunks;
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
