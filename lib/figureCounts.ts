import { vectorIndex } from "./vector";
import { documentOfFigureId } from "./figures";

// ---------------------------------------------------------------------------
// How many figures each document has, counted from the index itself.
// ---------------------------------------------------------------------------
// Deliberately not a column on `uploads`, even though `chunks` is one.
//
// Upstash has no count-by-filter: `range` takes a prefix and a cursor but no
// metadata filter, and `info()` reports only totals. A per-document prefix scan
// would mean one round trip per document on every page load. But figure ids are
// `${fileName}#figure-${n}`, so a single id-only scan of the whole index yields
// counts for every document at once — one request per 1,000 vectors, which at
// the current corpus size is one.
//
// The stronger reason is correctness. A stored count is a claim about the index
// that nothing keeps true: a partly-failed `embedFigures`, a re-extraction that
// finds fewer figures, or a manual delete all leave it lying, and it lies
// quietly. Counting the index cannot disagree with the index.

const PAGE_SIZE = 1000;
/** Stop rather than page forever if the index is far larger than expected. */
const MAX_PAGES = 50;

/**
 * Figure count per document name. Documents with no figures are absent rather
 * than zero — the caller knows which documents exist, this only knows which
 * ones have figures.
 */
export async function figureCountsByDocument(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  // Annotated, and the next cursor read into its own annotated binding: the
  // loop feeds `range`'s result back into its own argument, which TypeScript
  // cannot infer through without a break in the cycle.
  let cursor: string = "";

  for (let page = 0; page < MAX_PAGES; page++) {
    const result: { nextCursor: string; vectors: { id: string | number }[] } =
      await vectorIndex.range({
        cursor,
        limit: PAGE_SIZE,
        // Ids are all this needs, and metadata for ~1,000 chunks is megabytes
        // of document text fetched to count things it never looks at.
        includeVectors: false,
        includeMetadata: false,
      });

    for (const vector of result.vectors) {
      const document = documentOfFigureId(String(vector.id));
      if (document) counts.set(document, (counts.get(document) ?? 0) + 1);
    }

    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  return counts;
}
