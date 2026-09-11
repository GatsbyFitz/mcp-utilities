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
  MAX_EMBED_FIGURE_EDGE_PX,
  MAX_INLINE_FIGURE_EDGE_PX,
  MAX_STORED_FIGURE_EDGE_PX,
  STORED_FIGURE_SCALE,
  cropGeometry,
  usableBox,
  type FigureBox,
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
- the figure's bounding box on the page, as four separate numbers, each 0-1000 measured from the TOP-LEFT corner of the page:
  - "x0": left edge, "x1": right edge (x increases to the right)
  - "y0": top edge, "y1": bottom edge (y increases downward)
  Include the whole figure — every box, arrow, label and axis, plus its caption — and err on the generous side. A box that is too small loses part of the diagram permanently; a box that is too large only includes some whitespace. Exclude surrounding body text.

Report each box in the page's own frame, not relative to any other figure.`;

// Deliberately unconstrained, per the workflow rules: Gemini drops most JSON
// Schema string/array constraints, so `.min`/`.max` here would fail to steer
// the model while still rejecting otherwise-usable responses. Limits are
// applied in code below.
const FigureSchema = z.object({
  figures: z
    .array(
      z.object({
        description: z.string(),
        x0: z.number(),
        y0: z.number(),
        x1: z.number(),
        y1: z.number(),
      })
    )
    .default([]),
});

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

          // Logged because the failure mode is silent: a mislocated box still
          // produces a plausible-looking PNG, and the only way to tell a real
          // crop from a bad one after the fact is to have the numbers.
          const box = usableBox(figure);
          if (!box) {
            console.warn(
              `[extractFigures] ${fileName} p${page} #${n}: unusable box ` +
                `(${figure.x0}, ${figure.y0}, ${figure.x1}, ${figure.y1}) — cropping whole page`
            );
          }

          // Two renders of the same clip rectangle, not one render downscaled:
          // mupdf rasterises from the PDF each time, so the small copy costs a
          // little CPU and the stored copy loses nothing to its existence.
          const stored = cropPage(
            mupdf, loaded, bounds, box, STORED_FIGURE_SCALE, MAX_STORED_FIGURE_EDGE_PX
          );
          const forEmbedding = cropPage(
            mupdf, loaded, bounds, box, STORED_FIGURE_SCALE, MAX_EMBED_FIGURE_EDGE_PX
          );
          // A third render, for the copy a search tool returns inline. Stored
          // rather than derived on demand because there is no raster library
          // here to downscale with — mupdf rasterises from the PDF, and the
          // PDF is not in hand when a tool answers a query.
          const inline = cropPage(
            mupdf, loaded, bounds, box, STORED_FIGURE_SCALE, MAX_INLINE_FIGURE_EDGE_PX
          );

          const stem = `${figureBlobPrefix(fileName)}${uuidv4()}-p${page}-${n}`;
          const [blob, inlineBlob] = await Promise.all([
            put(`${stem}.png`, stored, {
              access: "public", addRandomSuffix: false, contentType: "image/png",
            }),
            put(`${stem}-inline.png`, inline, {
              access: "public", addRandomSuffix: false, contentType: "image/png",
            }),
          ]);

          return {
            page,
            description,
            imageUrl: blob.url,
            inlineImageUrl: inlineBlob.url,
            embedPngBase64: forEmbedding.toString("base64"),
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
 * A null box falls back to the whole page. A model that mislocated a figure
 * still tells us the page it is on, and a full page is worth more to the
 * reader than a dropped figure or a sliver of one.
 */
function cropPage(
  mupdf: typeof import("mupdf"),
  page: import("mupdf").Page,
  bounds: [number, number, number, number],
  box: FigureBox | null,
  maxScale: number,
  maxEdgePx: number
): Buffer {
  const { scale, target } = cropGeometry(bounds, box, maxScale, maxEdgePx);

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
