import type { Citation } from "@/lib/citations";
import { citationLabel } from "@/lib/citations";
import { MAX_INLINE_FIGURE_IMAGES, MAX_INLINE_FIGURE_BYTES } from "@/lib/figures";

// ---------------------------------------------------------------------------
// Figure PNGs returned inline in a tool result
// ---------------------------------------------------------------------------
// A search result that *is* a picture is not served by a link to the picture.
// The Markdown `![…](…)` every figure result carries only renders in a client
// that renders Markdown and will fetch a remote image, and the model answering
// the question never sees the pixels either way — it sees a URL. MCP has a
// content block for exactly this, so the image travels with the result.
//
// Inlining is bounded rather than universal: stored figures run up to 2048px,
// and base64 is ~1.33x, so eight of them is several megabytes on a transport
// that buffers the whole response. Anything not inlined still has its link in
// the text, so the cap costs reach, not access.

export interface InlineFigureImage {
  /** The result number it belongs to, so the text and the image can be paired. */
  n: number;
  label: string;
  /** base64, as MCP image content carries it. */
  data: string;
  mimeType: string;
}

/**
 * Fetches the figure PNGs among these results, most relevant first.
 *
 * Never throws and never fails the search: a figure that cannot be fetched, is
 * too large, or comes back as something other than an image is dropped, and
 * the result keeps the Markdown link it already had.
 */
export async function fetchFigureImages(
  results: { n: number; citation: Citation }[],
  limit: number = MAX_INLINE_FIGURE_IMAGES
): Promise<InlineFigureImage[]> {
  const figures = results.filter((r) => r.citation.inlineImageUrl).slice(0, limit);
  if (figures.length === 0) return [];

  const fetched = await Promise.all(
    figures.map(async ({ n, citation }) => {
      try {
        // The small copy, not the stored crop: images are billed by area, and
        // the full-size one costs about four times as much to say the same
        // thing. Older figures have no small copy and fall back to it.
        const res = await fetch(citation.inlineImageUrl!);
        if (!res.ok) return null;

        const mimeType = res.headers.get("content-type") ?? "image/png";
        if (!mimeType.startsWith("image/")) return null;

        // Checked before reading where the server declares it, and again after,
        // since a Blob response need not carry content-length.
        const declared = Number(res.headers.get("content-length") ?? NaN);
        if (Number.isFinite(declared) && declared > MAX_INLINE_FIGURE_BYTES) return null;

        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.byteLength > MAX_INLINE_FIGURE_BYTES) return null;

        const detail = citation.pages ? ` (${citation.pages})` : "";
        return {
          n,
          label: `[${n}] ${citationLabel(citation)}${detail}`,
          data: bytes.toString("base64"),
          mimeType,
        } satisfies InlineFigureImage;
      } catch (error) {
        console.warn(`[fetchFigureImages] result ${n}: skipped —`, error);
        return null;
      }
    })
  );

  return fetched.filter((f): f is InlineFigureImage => f !== null);
}
