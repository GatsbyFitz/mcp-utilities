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
 * A figure's box on its page, normalised to 0-1000 from the top-left corner.
 *
 * Named fields rather than a `[x0, y0, x1, y1]` array on purpose. Gemini's own
 * normalised-box convention is `[ymin, xmin, ymax, xmax]`, so a positional
 * array asks the model to abandon the ordering it was trained on and gives no
 * signal at all when it doesn't: the numbers are all in range, `usableBox`
 * passes, and the crop silently comes out transposed — a tall narrow slice of
 * the left of the page, cutting the diagram off down its right edge. Field
 * names cannot be transposed.
 */
export interface FigureBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Margin added to every side of a detected box, in the same 0-1000 units —
 * 1.5% of the page.
 *
 * A box that clips is worse than one that runs wide: a cropped-off axis label
 * or the right-hand column of a flowchart is lost for good, while a little
 * surrounding whitespace costs nothing to the reader and almost nothing to the
 * embedding. Clamped to the page, so padding can never push the crop outside
 * it.
 */
export const FIGURE_BOX_PADDING = 15;

/**
 * Smallest share of a page a real figure covers, as a fraction of its area.
 *
 * This is the backstop behind the prompt, for page furniture the model reports
 * as a figure anyway: a logo, a letterhead mark, a signature block, an icon.
 * Those are small — a header logo is perhaps 17% of the width and 5% of the
 * height, so under 1% of the page — while a process diagram worth indexing is
 * usually well into double figures. 3% sits in the gap with room either side.
 *
 * Deliberately checked *before* padding, so the margin added for legibility
 * cannot lift a logo over the bar.
 */
export const MIN_FIGURE_AREA = 0.03;

/**
 * Share of the page a box covers, 0-1, or NaN if the numbers are unusable.
 *
 * Corners are sorted here as they are in `usableBox`, so a box reported back
 * to front measures its real area rather than a negative one.
 */
export function boxArea(figure: { x0: number; y0: number; x1: number; y1: number }): number {
  const width = Math.abs(figure.x1 - figure.x0) / 1000;
  const height = Math.abs(figure.y1 - figure.y0) / 1000;
  return width * height;
}

/**
 * True for something too small to be worth indexing as a figure.
 *
 * Kept separate from `usableBox` because the two failures want opposite
 * handling. An unusable box means the model found a real figure and
 * mislocated it, so the whole page is the right fallback — a page is worth
 * more than a dropped diagram. A decorative mark means there was nothing worth
 * cropping in the first place, and falling back to the whole page there would
 * turn a logo into a full-page "figure": the worst possible outcome, since it
 * is then embedded, stored, and returned inline to a model as if it answered
 * something.
 */
export function isDecorative(figure: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const area = boxArea(figure);
  return Number.isFinite(area) && area > 0 && area < MIN_FIGURE_AREA;
}

/**
 * The padded box to crop, or null to fall back to the whole page.
 *
 * Corners are sorted rather than trusted: which number is the near edge is the
 * one thing left for a model to get backwards now that the axes are named, and
 * it costs nothing to recover. Everything else is a rejection — a box out of
 * range or enclosing almost no area is a misfire, and a sliver of a diagram is
 * worth less than the whole page it came from.
 */
export function usableBox(figure: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}): FigureBox | null {
  const corners = [figure.x0, figure.y0, figure.x1, figure.y1];
  if (corners.some((n) => !Number.isFinite(n))) return null;

  const x0 = Math.min(figure.x0, figure.x1);
  const x1 = Math.max(figure.x0, figure.x1);
  const y0 = Math.min(figure.y0, figure.y1);
  const y1 = Math.max(figure.y0, figure.y1);

  if (x0 < 0 || y0 < 0 || x1 > 1000 || y1 > 1000) return null;
  // Below about 5% of a side the crop is almost certainly a misfire.
  if (x1 - x0 < 50 || y1 - y0 < 50) return null;

  return {
    x0: Math.max(0, x0 - FIGURE_BOX_PADDING),
    y0: Math.max(0, y0 - FIGURE_BOX_PADDING),
    x1: Math.min(1000, x1 + FIGURE_BOX_PADDING),
    y1: Math.min(1000, y1 + FIGURE_BOX_PADDING),
  };
}

/**
 * Where to point the rasteriser, given a page and the box to crop from it.
 *
 * Pure arithmetic, kept out of the extraction step so it can be tested without
 * a PDF, a model call or the workflow runtime — this is the geometry that
 * decides whether a stored figure is the diagram or a slice of it, and it is
 * not otherwise observable until someone opens the PNG.
 *
 * `scale` is chosen to reach `maxScale` unless that would put the longest edge
 * past `maxEdgePx`, in which case it backs off just far enough. The target box
 * is then derived from its origin plus a bounded width and height rather than
 * by rounding both corners: flooring the near corner and ceiling the far one
 * grows the box by up to a pixel on each axis, which put a "768px" render at
 * 769. Harmless against a self-imposed budget, not against an API limit.
 */
export function cropGeometry(
  bounds: readonly [number, number, number, number],
  box: FigureBox | null,
  maxScale: number,
  maxEdgePx: number
): { scale: number; target: [number, number, number, number] } {
  const [pageX0, pageY0, pageX1, pageY1] = bounds;
  const width = pageX1 - pageX0;
  const height = pageY1 - pageY0;

  const region = box
    ? ([
        pageX0 + (box.x0 / 1000) * width,
        pageY0 + (box.y0 / 1000) * height,
        pageX0 + (box.x1 / 1000) * width,
        pageY0 + (box.y1 / 1000) * height,
      ] as const)
    : ([pageX0, pageY0, pageX1, pageY1] as const);

  const longest = Math.max(region[2] - region[0], region[3] - region[1]);
  const scale = Math.min(maxScale, maxEdgePx / Math.max(longest, 1));

  const originX = Math.floor(region[0] * scale);
  const originY = Math.floor(region[1] * scale);
  const targetWidth = Math.min(Math.ceil((region[2] - region[0]) * scale), maxEdgePx);
  const targetHeight = Math.min(Math.ceil((region[3] - region[1]) * scale), maxEdgePx);

  return {
    scale,
    target: [originX, originY, originX + targetWidth, originY + targetHeight],
  };
}

/**
 * Figure images returned inline by a search tool, and the byte ceiling for one.
 *
 * Stored figures are deliberately large (up to 2048px), and a tool response
 * carrying eight of them base64-encoded is several megabytes on a transport
 * that has to buffer the whole thing. These bound it: the rest of the results
 * still carry their Markdown image link, so nothing is hidden — it just isn't
 * inlined.
 */
export const MAX_INLINE_FIGURE_IMAGES = 4;
export const MAX_INLINE_FIGURE_BYTES = 1_500_000;

/**
 * A third render, stored alongside the full-size crop and used only when a
 * figure is returned inline by a search tool.
 *
 * Images are billed by area — roughly width x height / 750 tokens — so a
 * 2048px crop is ~3,500 tokens and four of them cost more than every text
 * result in the same response combined. At 1024px the same four cost ~3,500
 * between them, and a diagram at 1024px is still legible to a model that only
 * has to read its labels. The stored crop is untouched: it is what a person
 * opens from a citation, and that is a different job.
 */
export const MAX_INLINE_FIGURE_EDGE_PX = 1024;

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
  /** Public Blob URL of the smaller copy a search tool returns inline. */
  inlineImageUrl: string;
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
