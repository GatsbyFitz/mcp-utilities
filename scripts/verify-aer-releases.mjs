// Finding the workbooks, checked without the network.
//
// `verify:aer` covers reading numbers out of a sheet. This covers the step
// before it: working out which ninety-odd files to read, and from where.
//
// The URLs cannot be computed — the asset path carries the publication month,
// which has no fixed relation to the quarter, and the extension varies — so
// discovery fetches a document page per (schedule, quarter) and reads the link
// off it. Everything here is the pure half of that: which pages to ask for,
// and what to conclude from the answer. The fetch itself is the step's job.
//
// The one real sample is the href below, captured from the live page for
// Schedule 2 Q4 2023–24. Its shape is the whole reason this is a regex over
// HTML rather than a constructed file name.
//
// Run: pnpm verify:aer-releases
import {
  AER_ORIGIN,
  EARLIEST_FY_START,
  MAX_BACKFILL_TARGETS,
  discoveryTargets,
  documentPageUrl,
  documentPageUrls,
  parseLabel,
  quarterLabel,
  quarterLabelsBetween,
  resolveWorkbookUrl,
  workbookFromPage,
  workbookHrefs,
  requiresLogin,
} from "@/lib/aerReleases";
import { SCHEDULES, periodBounds } from "@/lib/aerPerformance";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n    ${detail}` : ""}`); }
};

// Captured from https://www.aer.gov.au/documents/schedule-2-quarter-4-2023-24-retail-performance-data
const REAL_HREF =
  "/system/files/2024-12/Schedule%202%20-%20Quarter%204%202023%E2%80%9324%20retail%20performance%20data.xlsm";
const REAL_PAGE = `<div class="file"><a href="${REAL_HREF}">Schedule 2 - Quarter 4 2023–24 retail performance data.xlsm</a></div>`;

console.log("Labels and page URLs:");
{
  check("a label round-trips", parseLabel(quarterLabel(2023, 4))?.fy === "2023-24");
  check("the quarter survives", parseLabel("2023-24 Q4")?.quarter === 4);
  check("an en-dash label parses", parseLabel("2023–24 Q4")?.fy === "2023-24",
    JSON.stringify(parseLabel("2023–24 Q4")));
  check("a four-digit second year narrows to two",
    parseLabel("2023-2024 Q4")?.fy === "2023-24", JSON.stringify(parseLabel("2023-2024 Q4")));
  check("nonsense is refused", parseLabel("last quarter") === null);

  // The three page URLs observed live, which is why this pattern is trusted.
  check("page URL matches the observed pattern",
    documentPageUrl(2, "2023-24 Q4") ===
      `${AER_ORIGIN}/documents/schedule-2-quarter-4-2023-24-retail-performance-data`,
    documentPageUrl(2, "2023-24 Q4"));
  check("and for another schedule and year",
    documentPageUrl(4, "2021-22 Q1") ===
      `${AER_ORIGIN}/documents/schedule-4-quarter-1-2021-22-retail-performance-data`,
    documentPageUrl(4, "2021-22 Q1"));
  // Hyphens in the page URL even though the file name uses an en-dash.
  check("the page URL carries no en-dash",
    !documentPageUrl(2, "2023–24 Q4").includes("–"), documentPageUrl(2, "2023–24 Q4"));
  check("an unparseable label yields no URL", documentPageUrl(2, "whenever") === null);

  // ---------------------------------------------------------------------
  // The two slug forms
  // ---------------------------------------------------------------------
  // The AER renamed the document-page slug between 2020-21 Q3 and 2021-22 Q1,
  // and the forms are mutually exclusive — no quarter answers on both. Probed
  // live across every quarter of 2018-19 to 2022-23 for all three schedules:
  // `q3` covers 2018-19 Q3 to 2020-21 Q3, `quarter-3` covers 2021-22 Q1 on.
  // These pin the exact strings those probes returned 200 for.
  check("the old era's page URL uses the short form",
    documentPageUrls(2, "2020-21 Q1")[0] ===
      `${AER_ORIGIN}/documents/schedule-2-q1-2020-21-retail-performance-data`,
    documentPageUrls(2, "2020-21 Q1")[0]);
  check("and the new era's uses the long form",
    documentPageUrls(2, "2021-22 Q1")[0] ===
      `${AER_ORIGIN}/documents/schedule-2-quarter-1-2021-22-retail-performance-data`,
    documentPageUrls(2, "2021-22 Q1")[0]);
  check("the last short-form quarter observed is ordered short-first",
    documentPageUrls(3, "2020-21 Q3")[0].includes("-q3-2020-21-"),
    documentPageUrls(3, "2020-21 Q3")[0]);
  check("the first long-form quarter observed is ordered long-first",
    documentPageUrls(3, "2021-22 Q1")[0].includes("-quarter-1-2021-22-"),
    documentPageUrls(3, "2021-22 Q1")[0]);

  // Both forms are always offered. The cutoff decides the order, never the
  // set — a hardcoded cutoff would be a prediction about the next rename, and
  // being wrong about it is a silent miss rather than a visible error.
  for (const label of ["2018-19 Q3", "2020-21 Q3", "2021-22 Q1", "2025-26 Q2"]) {
    const urls = documentPageUrls(2, label);
    check(`${label} offers both slug forms`, urls.length === 2, JSON.stringify(urls));
    check(`${label}'s candidates are distinct`,
      new Set(urls).size === 2, JSON.stringify(urls));
  }
  check("an unparseable label offers no candidates",
    documentPageUrls(2, "whenever").length === 0);
  check("documentPageUrl is the first candidate",
    documentPageUrl(2, "2020-21 Q1") === documentPageUrls(2, "2020-21 Q1")[0]);
}

console.log("Enumerating the range:");
{
  const one = quarterLabelsBetween(2023, 2023);
  check("a financial year is four quarters", one.length === 4, JSON.stringify(one));
  check("they are in order", one[0] === "2023-24 Q1" && one[3] === "2023-24 Q4");
  check("the century rolls over", quarterLabel(2099, 1) === "2099-00 Q1", quarterLabel(2099, 1));
  check("every emitted label is one periodBounds accepts",
    quarterLabelsBetween(2018, 2026).every((l) => periodBounds(l) !== null));
  check("an inverted range is empty, not infinite",
    quarterLabelsBetween(2024, 2023).length === 0);

  // A quarter that has not finished cannot have been published, and a skip
  // line for it reads exactly like one for a page that was renamed. Filtering
  // the impossible keeps the report's remaining skips meaningful.
  const asOf = new Date("2024-08-15T00:00:00Z");
  const upToNow = quarterLabelsBetween(2023, 2026, asOf);
  check("a quarter that has not ended yet is not emitted",
    !upToNow.includes("2024-25 Q1"), JSON.stringify(upToNow));
  check("the last finished quarter is",
    upToNow.includes("2023-24 Q4") && upToNow[upToNow.length - 1] === "2023-24 Q4",
    JSON.stringify(upToNow));
  // Publication lag is deliberately not modelled: a finished-but-unpublished
  // quarter is a real "not yet published" and belongs in the report.
  check("a finished quarter is emitted even if the AER is months behind",
    quarterLabelsBetween(2023, 2024, new Date("2024-07-02T00:00:00Z")).includes("2023-24 Q4"));
  check("without asOf nothing is filtered",
    quarterLabelsBetween(2024, 2024).length === 4);

  const targets = discoveryTargets(quarterLabelsBetween(EARLIEST_FY_START, 2025));
  check("the whole published history is one target per schedule per quarter",
    targets.length === quarterLabelsBetween(EARLIEST_FY_START, 2025).length * SCHEDULES.length,
    `${targets.length} targets`);
  // One target per pair, carrying both URLs — not two targets. Two would make
  // a quarter found under the second form report as one hit plus one spurious
  // "not published", and the skip list is the only thing anyone reads.
  check("a target carries its candidates rather than being split in two",
    targets.every((t) => Array.isArray(t.pageUrls) && t.pageUrls.length === 2),
    JSON.stringify(targets[0]));
  check("the bound counts targets, so the request ceiling is twice it",
    targets.flatMap((t) => t.pageUrls).length === targets.length * 2);
  // The backfill hits someone else's server once per target; the bound is there
  // so a mistyped range cannot turn into thousands of requests.
  check("the whole history fits inside the bound",
    targets.length <= MAX_BACKFILL_TARGETS, `${targets.length} vs ${MAX_BACKFILL_TARGETS}`);
}

console.log("Reading the link off a real page:");
{
  const hrefs = workbookHrefs(REAL_PAGE);
  check("the workbook href is found", hrefs.length === 1 && hrefs[0] === REAL_HREF, JSON.stringify(hrefs));
  check(".xlsm is found as readily as .xlsx",
    workbookHrefs('<a href="/f/x.xlsx">a</a>').length === 1 &&
      workbookHrefs('<a href="/f/x.xlsm">a</a>').length === 1);
  check("a PDF or a CSV on the same page is not mistaken for one",
    workbookHrefs('<a href="/f/notes.pdf">n</a><a href="/f/d.csv">d</a>').length === 0);
  check("single quotes and spacing do not hide it",
    workbookHrefs("<a href = '/f/x.xlsm'>a</a>").length === 1);
  check("the same link twice is one link",
    workbookHrefs(`<a href="/f/x.xlsm">a</a><a href="/f/x.xlsm">b</a>`).length === 1);

  const url = resolveWorkbookUrl(REAL_HREF);
  check("it resolves to an absolute AER URL", url === `${AER_ORIGIN}${REAL_HREF}`, url);
  check("the percent-encoding is preserved, en-dash and all",
    url.includes("%E2%80%93") && url.endsWith(".xlsm"), url);
  // The fetch that follows leaves from inside the deployment, so the host set
  // stays closed here too, not only in downloadToBlob.
  check("an off-origin link is refused",
    resolveWorkbookUrl("https://example.com/evil.xlsx") === null);
  check("a protocol-relative off-origin link is refused",
    resolveWorkbookUrl("//example.com/evil.xlsx") === null,
    String(resolveWorkbookUrl("//example.com/evil.xlsx")));
  check("http is refused", resolveWorkbookUrl("http://www.aer.gov.au/f/x.xlsx") === null);
}

console.log("Deciding what one page means:");
{
  const got = workbookFromPage(2, "2023-24 Q4", "p", 200, REAL_PAGE);
  check("a good page yields a workbook", "workbook" in got, JSON.stringify(got));
  check("carrying its schedule and period",
    got.workbook.schedule === 2 && got.workbook.periodLabel === "2023-24 Q4");
  check("and the page it came from, so a wrong link is traceable",
    got.workbook.pageUrl === "p");

  // A quarter that is not published is the expected case when walking a range,
  // not a failure: the range is a guess at what exists.
  const missing = workbookFromPage(3, "2030-31 Q1", "p", 404, "");
  check("a 404 is 'not published', not an error",
    "skip" in missing && missing.skip.reason === "not-published", JSON.stringify(missing));
  check("so is a 500 — the quarter is simply not had",
    workbookFromPage(3, "x", "p", 500, "").skip.reason === "not-published");

  // Observed live on all three schedules for 2024-25 Q3: a 200 carrying a
  // 682-byte redirect interstitial. Reported as a parser miss it would send
  // someone to debug a regex over a quarter that is merely behind a login.
  const GATED =
    '<html><head><title>Redirecting to https://www.aer.gov.au/user/login?destination=' +
    '/documents/schedule-2-quarter-3-2024-25-retail-performance-data</title></head></html>';
  check("a login interstitial is recognised", requiresLogin(GATED));
  check("an ordinary page is not", !requiresLogin(REAL_PAGE));
  check("a gated page is 'requires-login', not a parser miss",
    workbookFromPage(2, "2024-25 Q3", "p", 200, GATED).skip.reason === "requires-login",
    JSON.stringify(workbookFromPage(2, "2024-25 Q3", "p", 200, GATED)));

  // These two must not read alike. One is a quarter that is not there; the
  // other is a page whose shape changed, where any single pick is a guess.
  check("a page with no workbook says so",
    workbookFromPage(2, "x", "p", 200, "<p>nothing here</p>").skip.reason === "no-workbook-link");
  check("a page with several says so differently",
    workbookFromPage(2, "x", "p", 200,
      '<a href="/a.xlsx">a</a><a href="/b.xlsm">b</a>').skip.reason === "ambiguous-links");
  check("and names what it found, so the change is diagnosable",
    workbookFromPage(2, "x", "p", 200,
      '<a href="/a.xlsx">a</a><a href="/b.xlsm">b</a>').skip.detail?.includes("/a.xlsx"));
  check("an off-origin link is its own reason",
    workbookFromPage(2, "x", "p", 200,
      '<a href="https://elsewhere.test/x.xlsx">a</a>').skip.reason === "off-origin-link");
}

console.log(failures === 0 ? "\nAll AER discovery checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
