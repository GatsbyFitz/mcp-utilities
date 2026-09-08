// ---------------------------------------------------------------------------
// Figures extracted from a PDF page: the shared vocabulary between the
// extraction step, the embedding step, and the tools that cite them.
//
// Figures live in the same Upstash index as text chunks but in their own ID
// namespace. That is the whole reason this feature needs no re-ingest: text
// chunk IDs never move, so the chunking invariant holds and every `chunkId`
// stored on a Neo4j relationship keeps resolving. Never put a figure through
// `chunkText`.
// ---------------------------------------------------------------------------

import { stripPageMarkers, pageAt } from "./chunking";

/** Marks a vector entry as a figure rather than a text chunk. */
export const FIGURE_KIND = "figure";

/**
 * `#` rather than `-fig-` so the namespace cannot be forged by a file name:
 * `chunkId` produces `${fileName}-${index}`, so a document literally named
 * `report-fig` would otherwise collide with figures of `report`. This is the
 * same class of bug the comment in deleteDocument warns about for prefix
 * deletes.
 */
export function figureId(fileName: string, index: number): string {
  return `${fileName}#figure-${index}`;
}

/** Longest edge of a stored figure PNG. See extractFigures for why it matters. */
export const MAX_FIGURE_EDGE_PX = 1024;

/** Rendering scale for the page a figure is cropped out of. */
export const FIGURE_RENDER_SCALE = 2;

/** Ceiling on pages rendered per document, so one pathological PDF can't run away. */
export const MAX_FIGURE_PAGES = 40;

/** Ceiling on figures kept per page. */
export const MAX_FIGURES_PER_PAGE = 6;

export const MAX_FIGURE_DESCRIPTION = 1200;

/**
 * Blob prefix holding one document's figure PNGs.
 *
 * The file name is a path segment rather than part of the leaf name so the
 * whole set is listable, and therefore deletable, for a given document. With
 * a uuid-first leaf (`figures/<uuid>-<file>-p1-0.png`) there is no prefix that
 * selects one document's figures, and deleting a document would orphan every
 * PNG it produced.
 */
export function figureBlobPrefix(fileName: string): string {
  return `figures/${fileName}/`;
}

export interface ExtractedFigure {
  /** 1-indexed printed page the figure sits on. */
  page: number;
  description: string;
  /** Public Blob URL of the cropped PNG. */
  imageUrl: string;
  /** The same PNG, base64, handed to the embedding step so it needn't refetch. */
  pngBase64: string;
}

/**
 * Pages worth rendering, taken from markers `createMarkdown` already emits.
 *
 * `PARSE_PROMPT` asks Gemini to describe figures as `[Figure: ...]` and to
 * emit a page-break line before each page, so the pages containing figures are
 * derivable from output we already have — no extra model call, and no
 * rendering of the many pages that are pure prose.
 */
export function figurePagesFrom(markdown: string): number[] {
  const { text, breaks } = stripPageMarkers(markdown);
  const pages = new Set<number>();

  for (const match of text.matchAll(/\[Figure:/gi)) {
    pages.add(pageAt(breaks, match.index));
  }

  return [...pages].sort((a, b) => a - b).slice(0, MAX_FIGURE_PAGES);
}
