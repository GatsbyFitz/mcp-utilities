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

/**
 * Id prefix covering every figure of one document.
 *
 * `range` filters by id prefix — it has no metadata filter — so this is how a
 * single document's figures are read back without scanning the whole index.
 */
export function figureIdPrefix(fileName: string): string {
  return `${fileName}#figure-`;
}

/**
 * The document a figure vector belongs to, or null if the id is not a figure.
 *
 * The inverse of `figureId`. Splits on the *last* separator rather than the
 * first, so a file name that itself contains "#figure-" cannot truncate the
 * name it returns.
 */
export function documentOfFigureId(id: string): string | null {
  const at = id.lastIndexOf("#figure-");
  if (at <= 0) return null;
  const index = id.slice(at + "#figure-".length);
  return /^\d+$/.test(index) ? id.slice(0, at) : null;
}

// A figure is rendered twice, at two resolutions, for two different consumers.
// They are not the same image and must not be collapsed into one: the API
// limits below constrain what can be *embedded*, and nothing at all constrains
// what can be *stored*.

/**
 * The stored PNG — what a reader opens from a citation to study a dense
 * process diagram, so it is deliberately generous. ~288 DPI at scale 4.
 */
export const STORED_FIGURE_SCALE = 4;
export const MAX_STORED_FIGURE_EDGE_PX = 2048;

/**
 * The copy sent as `inlineData` when embedding. Never stored, never linked,
 * never shown. Small because it shares an 8,192-token request budget with the
 * description and with up to three other figures.
 */
export const MAX_EMBED_FIGURE_EDGE_PX = 768;

/** Rendering scale for the whole page handed to the model for figure detection. */
export const FIGURE_RENDER_SCALE = 2;

/**
 * Figures per embedding request. Derived from two `gemini-embedding-2` API
 * limits, not a throughput knob — raising it to save round trips reintroduces
 * a hard failure:
 *   - a request may carry at most 6 images, and
 *   - the *overall* input budget is 8,192 tokens, shared between every image
 *     and every description in the request.
 * Four leaves headroom under both. `embedMany` sends all values in one request
 * regardless of image count, so the batching has to happen at the call site.
 */
export const MAX_FIGURES_PER_EMBED_REQUEST = 4;

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

/** One stored figure, as read back for display. */
export interface DocumentFigure {
  id: string;
  imageUrl: string;
  description: string;
  page: number | null;
}

export interface ExtractedFigure {
  /** 1-indexed printed page the figure sits on. */
  page: number;
  description: string;
  /** Public Blob URL of the high-resolution crop. This is the one people see. */
  imageUrl: string;
  /**
   * A *separate*, smaller render of the same region, base64, for the embedding
   * request only. Named for its purpose so it cannot be mistaken for the
   * stored image and written to Blob by accident.
   */
  embedPngBase64: string;
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
