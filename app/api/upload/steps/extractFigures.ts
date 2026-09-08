import { FatalError } from "workflow";
import { generateText, Output } from "ai";
import * as z from "zod/v4";
import { v4 as uuidv4 } from "uuid";
import { del, list, put } from "@vercel/blob";
import { mapPool } from "@/lib/pool";
import {
  FIGURE_RENDER_SCALE,
  MAX_FIGURES_PER_PAGE,
  MAX_FIGURE_DESCRIPTION,
  MAX_FIGURE_EDGE_PX,
  figureBlobPrefix,
  figurePagesFrom,
  type ExtractedFigure,
} from "@/lib/figures";

// ---------------------------------------------------------------------------
// Step: crop figures out of the PDF's pages
// ---------------------------------------------------------------------------
// The Markdown parse describes a figure in words and throws the pixels away.
// This renders the pages that carry a `[Figure: ...]` marker, asks the model
// where on the page each figure actually is, and stores the crop.
//
// Rendering is done with mupdf, which is pure WASM. `.npmrc` sets
// ignore-scripts=true and every native build has to be allowlisted in
// pnpm-workspace.yaml — a native rasteriser here would be one more entry that
// can fail a cold install, which is exactly how the unrs-resolver deploy broke.

const FIND_PROMPT = `You are given one page rendered from a regulatory PDF.

Identify every figure on the page: diagrams, process flows, flowcharts, charts, schematics, and images of tables. Do NOT report ordinary body text, headers, footers, page numbers, or rule lines as figures. If the page has none, return an empty array.

For each figure:
- "description": what the figure shows, in prose, grounded in what is visible. Name the entities, the roles, and the direction of any flow — this text is what someone searching will match against, so "Process flow: Retailer submits a change request to AEMO, which notifies the incumbent Metering Coordinator within 2 business days" is useful and "a diagram" is not. Transcribe labels exactly as written.
- "bbox": the figure's bounding box on the page as [x0, y0, x1, y1], each 0-1000, measured from the top-left corner. Include the figure's own caption and axis labels; exclude surrounding body text.`;

// Deliberately unconstrained, per the workflow rules: Gemini drops most JSON
// Schema string/array constraints, so `.min`/`.max` here would fail to steer
// the model while still rejecting otherwise-usable responses. Limits are
// applied in code below.
const FigureSchema = z.object({
  figures: z
    .array(
      z.object({
        description: z.string(),
        bbox: z.array(z.number()),
      })
    )
    .default([]),
});

/** A bbox is only usable if it is in range and encloses a non-trivial area. */
function usableBox(bbox: number[]): boolean {
  if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) return false;
  const [x0, y0, x1, y1] = bbox;
  if (x0 < 0 || y0 < 0 || x1 > 1000 || y1 > 1000) return false;
  // Below about 5% of a side the crop is almost certainly a misfire, and a
  // sliver of a diagram is worth less than the whole page it came from.
  return x1 - x0 >= 50 && y1 - y0 >= 50;
}

export async function extractFigures(
  fileName: string,
  blobUrl: string,
  markdown: string
): Promise<ExtractedFigure[]> {
  "use step";

  const pages = figurePagesFrom(markdown);

  // Clear any previous run's PNGs before writing new ones. Re-running with a
  // changed prompt produces different crops under different names, so without
  // this every re-extraction would leave its predecessors behind in Blob with
  // nothing referencing them. Runs before the early return so a document that
  // now yields no figures still gets cleaned up.
  await deleteFigureBlobs(fileName);

  if (pages.length === 0) return [];

  const res = await fetch(blobUrl);
  if (!res.ok) throw new FatalError(`Blob fetch failed: ${res.status}`);
  const pdf = new Uint8Array(await res.arrayBuffer());

  // Imported here rather than at module scope: mupdf loads a WASM binary, and
  // this step is the only thing in the pipeline that needs it.
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  const pageCount = doc.countPages();

  const perPage = await mapPool(pages, 3, async (page) => {
    // `page` is the printed page number from the parse; the document is
    // 0-indexed and the two can disagree if the PDF has front matter.
    const index = page - 1;
    if (index < 0 || index >= pageCount) return [];

    try {
      const loaded = doc.loadPage(index);
      const bounds = loaded.getBounds();
      const full = loaded.toPixmap(
        mupdf.Matrix.scale(FIGURE_RENDER_SCALE, FIGURE_RENDER_SCALE),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true
      );
      const pagePng = Buffer.from(full.asPNG());

      const { output } = await generateText({
        model: "google/gemini-3.5-flash-lite",
        output: Output.object({ schema: FigureSchema }),
        messages: [
          {
            role: "user",
            content: [
              { type: "image", image: pagePng, mediaType: "image/png" },
              { type: "text", text: FIND_PROMPT },
            ],
          },
        ],
      });

      const found = (output.figures ?? []).slice(0, MAX_FIGURES_PER_PAGE);
      if (found.length === 0) return [];

      return await Promise.all(
        found.map(async (figure, n) => {
          const description = figure.description.trim().slice(0, MAX_FIGURE_DESCRIPTION);
          if (!description) return null;

          const png = cropPage(mupdf, loaded, bounds, figure.bbox);
          const blob = await put(
            `${figureBlobPrefix(fileName)}${uuidv4()}-p${page}-${n}.png`,
            png,
            { access: "public", addRandomSuffix: false, contentType: "image/png" }
          );

          return {
            page,
            description,
            imageUrl: blob.url,
            pngBase64: png.toString("base64"),
          } satisfies ExtractedFigure;
        })
      );
    } catch (error) {
      // Degrade, never abort: by this point the document has already paid for
      // the parse and the embeddings, and losing all of that because one page
      // failed to render or the model returned something unparseable would be
      // a far worse outcome than a document with fewer figures.
      console.warn(`[extractFigures] ${fileName} page ${page}: skipped —`, error);
      return [];
    }
  });

  return perPage.flat().filter((f): f is ExtractedFigure => f !== null);
}

/**
 * Renders just the figure's region of the page.
 *
 * A Pixmap sized to the crop, with the page run into it through the same
 * scale matrix, gives an exact crop with no second image library — the
 * alternative would be rendering the whole page and cropping the PNG, which
 * needs a raster library this project deliberately does not have.
 *
 * An unusable bbox falls back to the whole page. A model that mislocated a
 * figure still tells us the page it is on, and a full page is worth more to
 * the reader than a dropped figure or a sliver of one.
 */
function cropPage(
  mupdf: typeof import("mupdf"),
  page: import("mupdf").Page,
  bounds: [number, number, number, number],
  bbox: number[]
): Buffer {
  const [pageX0, pageY0, pageX1, pageY1] = bounds;
  const width = pageX1 - pageX0;
  const height = pageY1 - pageY0;

  const region = usableBox(bbox)
    ? ([
        pageX0 + (bbox[0] / 1000) * width,
        pageY0 + (bbox[1] / 1000) * height,
        pageX0 + (bbox[2] / 1000) * width,
        pageY0 + (bbox[3] / 1000) * height,
      ] as const)
    : ([pageX0, pageY0, pageX1, pageY1] as const);

  // Keep the longest edge bounded: this PNG is about to be base64'd into an
  // embedding request body, so its size is a request-size constraint rather
  // than a display preference.
  const longest = Math.max(region[2] - region[0], region[3] - region[1]);
  const scale = Math.min(FIGURE_RENDER_SCALE, MAX_FIGURE_EDGE_PX / Math.max(longest, 1));

  const target: [number, number, number, number] = [
    Math.floor(region[0] * scale),
    Math.floor(region[1] * scale),
    Math.ceil(region[2] * scale),
    Math.ceil(region[3] * scale),
  ];

  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, target, false);
  pixmap.clear(255);
  const device = new mupdf.DrawDevice(mupdf.Matrix.scale(scale, scale), pixmap);
  page.run(device, mupdf.Matrix.identity);
  device.close();

  return Buffer.from(pixmap.asPNG());
}

/**
 * Removes every stored figure PNG for a document. Shared with deleteDocument,
 * which would otherwise orphan them.
 */
export async function deleteFigureBlobs(fileName: string): Promise<void> {
  const { blobs } = await list({ prefix: figureBlobPrefix(fileName) });
  if (blobs.length > 0) await del(blobs.map((b) => b.url));
}
