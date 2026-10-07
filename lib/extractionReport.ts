import type { FigureReport } from "@/lib/figures";
import type { ProcessReport } from "@/lib/processes";

// ---------------------------------------------------------------------------
// Turning a run's counters into something a person can act on
// ---------------------------------------------------------------------------
// Pure, and importing nothing that builds a client, so the page can render
// these and `pnpm verify:extraction-report` can pin them with no network.
//
// The thing being fixed here: a figure run that produced nothing used to
// report nothing, and "0 figures" has four causes that are indistinguishable
// from outside. Only one of them means the document has no diagrams. The
// others are a parse that wrote no markers, pages that failed to render, and
// a model that found only page furniture — and the remedy differs for each.
// So every outcome carries a `hint` when there is something to *do*.

export interface ExtractionOutcome {
  /** One line, always present: what the run produced. */
  headline: string;
  /** The counts behind it, for someone who wants them. May be empty. */
  detail: string[];
  /** What to do about it. Present only when there is an action worth taking. */
  hint: string | null;
  /** True when the run completed but produced nothing — worth saying loudly. */
  empty: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What a figure extraction did.
 *
 * `markedPages === 0` is the case worth separating from every other: the PDF
 * was never opened. The Markdown that run is working from carries no
 * `[Figure:` markers, so no page was selected for rendering, so no diagram in
 * the document could possibly have been found. Re-running figure extraction
 * against the same Markdown will return zero again, forever. The only thing
 * that changes it is a fresh parse of the PDF.
 */
export function describeFigureRun(report: FigureReport): ExtractionOutcome {
  const detail: string[] = [];

  if (report.markedPages === 0) {
    return {
      headline: "No figures — the stored Markdown marks no figure pages",
      detail: [
        "No page was rendered, so the PDF itself was never examined.",
      ],
      hint:
        "The PDF→Markdown parse wrote no [Figure: …] markers for this document. " +
        "Re-extracting figures from the same Markdown cannot change that — " +
        "re-ingest the document so the PDF is parsed again.",
      empty: true,
    };
  }

  detail.push(
    `${plural(report.pagesScanned, "page")} scanned of ${plural(report.markedPages, "marked page")}`
  );
  if (report.proposed > 0) detail.push(`${plural(report.proposed, "figure")} proposed`);
  if (report.droppedDecorative > 0) {
    detail.push(`${report.droppedDecorative} dropped as page furniture`);
  }
  if (report.droppedEmpty > 0) detail.push(`${report.droppedEmpty} dropped with no description`);
  if (report.wholePageFallbacks > 0) {
    detail.push(`${report.wholePageFallbacks} cropped as a whole page (box unusable)`);
  }
  if (report.pagesFailed > 0) detail.push(`${plural(report.pagesFailed, "page")} failed`);

  if (report.kept === 0) {
    // Every page that was asked about came back empty or furniture. That is a
    // real answer — but if pages also failed, it is a partial one.
    const everythingFailed = report.pagesFailed > 0 && report.pagesScanned === report.pagesFailed;
    return {
      headline: "No figures kept",
      detail,
      hint: everythingFailed
        ? "Every page failed to render or parse — this is a fault, not an empty document. Re-run it."
        : report.proposed === 0
          ? "The pages were rendered and the model found nothing on them. If the document does have diagrams, the figure prompt is the thing to change."
          : "Everything found was judged page furniture. If a real diagram was dropped, MIN_FIGURE_AREA in lib/figures.ts is the threshold.",
      empty: true,
    };
  }

  return {
    headline: `${plural(report.kept, "figure")} extracted`,
    detail,
    hint:
      report.pagesFailed > 0
        ? `${plural(report.pagesFailed, "page")} failed, so this may be short of what the document holds.`
        : null,
    empty: false,
  };
}

/**
 * What a process scan did.
 *
 * The distinction that matters: a document whose figures are bar charts
 * genuinely has no processes, and should not read like a failure. A document
 * with no figures at all has not been asked the question yet.
 */
export function describeProcessRun(report: ProcessReport): ExtractionOutcome {
  if (report.figuresAvailable === 0) {
    return {
      headline: "No processes — this document has no figures",
      detail: ["A process is read out of a figure, so there was nothing to read."],
      hint: "Extract figures first; if that also comes back empty, start there.",
      empty: true,
    };
  }

  const detail: string[] = [`${plural(report.examined, "figure")} examined`];
  if (report.notProcess > 0) detail.push(`${report.notProcess} were not processes`);
  if (report.unreadable > 0) detail.push(`${report.unreadable} could not be read`);
  if (report.repaired > 0) detail.push(`${report.repaired} repaired`);
  if (report.invalid > 0) detail.push(`${report.invalid} still invalid Mermaid`);

  if (report.processCount === 0) {
    return {
      headline: "No processes found",
      detail,
      hint:
        report.unreadable === report.examined
          ? "Every crop failed to load — this is a fault, not an empty document."
          : "The figures were read and none depicts a process. For a document of charts and photographs that is the right answer.",
      empty: true,
    };
  }

  return {
    headline: `${plural(report.processCount, "process", "processes")} transcribed`,
    detail,
    // Stored and shown as the figure crop instead, so this is worth knowing
    // but is not a failure: the machine-readable copy is still the only one.
    hint:
      report.invalid > 0
        ? `${report.invalid} did not survive validation and will render as the figure image.`
        : null,
    empty: false,
  };
}
