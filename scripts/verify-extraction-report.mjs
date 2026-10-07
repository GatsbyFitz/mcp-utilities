// The part of extraction reporting that has to be unambiguous.
//
// "0 figures" has four causes and only one of them means the document has no
// diagrams. Telling them apart is the entire reason this code exists, so the
// check is that each cause produces a *different* and actionable message —
// above all the one that cost a long diagnosis: a stored Markdown with no
// `[Figure:` markers, where the PDF is never opened and re-extracting can
// never help.
//
// Pure: no model, no network, no database.
//
// Run: pnpm verify:extraction-report
import { describeFigureRun, describeProcessRun } from "@/lib/extractionReport";
import { emptyFigureReport } from "@/lib/figures";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n    ${detail}` : ""}`); }
};

const figures = (over) => ({ ...emptyFigureReport(), ...over });
const processes = (over) => ({
  figuresAvailable: 0, examined: 0, notProcess: 0, unreadable: 0,
  processCount: 0, repaired: 0, invalid: 0, ...over,
});

console.log("A document whose Markdown marks no figure pages:");
{
  // The real case: b2b-procedure-data-posting-process-v401.pdf has a swimlane
  // diagram on page 7 and zero figures indexed, because its parse wrote no
  // markers. Re-extracting figures reads the same Markdown and finds the same
  // nothing, so the message has to send you to a re-ingest, not a re-extract.
  const out = describeFigureRun(figures({ markedPages: 0 }));
  check("says the Markdown is what is empty, not the PDF",
    /marks no figure pages/i.test(out.headline), out.headline);
  check("says the PDF was never examined",
    out.detail.join(" ").includes("never examined"), JSON.stringify(out.detail));
  check("sends you to a re-ingest, not another extraction",
    /re-ingest/i.test(out.hint ?? "") && /cannot change that/i.test(out.hint ?? ""), out.hint);
  check("is flagged empty", out.empty === true);
}

console.log("Pages scanned, model found nothing:");
{
  const out = describeFigureRun(figures({ markedPages: 3, pagesScanned: 3, proposed: 0 }));
  check("does not blame the Markdown", !/marks no figure pages/i.test(out.headline), out.headline);
  check("points at the figure prompt", /figure prompt/i.test(out.hint ?? ""), out.hint);
  check("reports what was scanned", out.detail.some((d) => d.includes("3 pages scanned")),
    JSON.stringify(out.detail));
}

console.log("Everything found was page furniture:");
{
  const out = describeFigureRun(
    figures({ markedPages: 2, pagesScanned: 2, proposed: 5, droppedDecorative: 5 })
  );
  check("names the threshold that dropped them",
    /MIN_FIGURE_AREA/.test(out.hint ?? ""), out.hint);
  check("separates this from 'found nothing'", !/figure prompt/i.test(out.hint ?? ""), out.hint);
}

console.log("Every page failed:");
{
  const out = describeFigureRun(figures({ markedPages: 2, pagesScanned: 2, pagesFailed: 2 }));
  // The one empty result that is a bug rather than an answer.
  check("calls it a fault, not an empty document",
    /fault, not an empty document/i.test(out.hint ?? ""), out.hint);
}

console.log("Figures extracted:");
{
  const out = describeFigureRun(
    figures({ markedPages: 4, pagesScanned: 4, proposed: 9, droppedDecorative: 2, kept: 7 })
  );
  check("counts what was kept", out.headline === "7 figures extracted", out.headline);
  check("is not flagged empty", out.empty === false);
  check("stays quiet when there is nothing to do", out.hint === null, out.hint);
}
{
  // A partial result must not read as a complete one.
  const out = describeFigureRun(
    figures({ markedPages: 5, pagesScanned: 5, pagesFailed: 2, proposed: 3, kept: 3 })
  );
  check("warns that a partial result may be short",
    /may be short/i.test(out.hint ?? ""), out.hint);
}

console.log("Processes, with no figures to read:");
{
  const out = describeProcessRun(processes({ figuresAvailable: 0 }));
  check("blames the missing figures, not the document",
    /has no figures/i.test(out.headline), out.headline);
  check("sends you to figure extraction first",
    /Extract figures first/i.test(out.hint ?? ""), out.hint);
}

console.log("Processes, figures read and none is a process:");
{
  const out = describeProcessRun(processes({ figuresAvailable: 6, examined: 6, notProcess: 6 }));
  check("treats it as the right answer, not a failure",
    /right answer/i.test(out.hint ?? ""), out.hint);
  check("still flags it empty so it is visible", out.empty === true);
}

console.log("Processes, every crop unreadable:");
{
  const out = describeProcessRun(processes({ figuresAvailable: 6, examined: 6, unreadable: 6 }));
  check("calls it a fault", /fault, not an empty document/i.test(out.hint ?? ""), out.hint);
}

console.log("Processes transcribed:");
{
  const out = describeProcessRun(
    processes({ figuresAvailable: 38, examined: 38, notProcess: 8, processCount: 30, repaired: 4, invalid: 2 })
  );
  check("counts them, pluralised correctly", out.headline === "30 processes transcribed", out.headline);
  check("reports the repairs", out.detail.some((d) => d.includes("4 repaired")), JSON.stringify(out.detail));
  // Invalid Mermaid is stored and shown as the crop, so it is a caveat, not a failure.
  check("says what an invalid diagram will do",
    /render as the figure image/i.test(out.hint ?? ""), out.hint);
  check("is not flagged empty", out.empty === false);
}
{
  const out = describeProcessRun(processes({ figuresAvailable: 1, examined: 1, processCount: 1 }));
  check("one process is singular", out.headline === "1 process transcribed", out.headline);
}

console.log(failures === 0 ? "\nAll extraction-report checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
