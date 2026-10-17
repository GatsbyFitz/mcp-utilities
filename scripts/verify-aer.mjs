// The half of AER ingestion that has to be exactly right.
//
// A model infers which column means what, because the schedules' layout drifts
// between quarters. It never emits a value — the numbers are read from the
// cells by the code below. So this check runs with no model, no network and no
// credentials: it feeds `extractRows` a hand-written mapping and asserts the
// numbers that come out are the numbers that went in.
//
// The cases are the ones that would otherwise corrupt a regulatory statistic
// quietly: a blank cell becoming 0, a header row off by one, a renamed column
// splitting a series in two.
//
// Run: pnpm verify:aer
import {
  extractRows,
  mappingProblems,
  numericValue,
} from "@/lib/sheetMapping";
import { canonicalMetric, periodBounds } from "@/lib/aerPerformance";
import { PDF_KIND, SPREADSHEET_KIND, fileNameFromUrl } from "@/lib/fetchDocument";
import { ALLOWED_SPREADSHEET_CONTENT_TYPES, ALLOWED_UPLOAD_CONTENT_TYPES } from "@/lib/upload";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n    ${detail}` : ""}`); }
};

/** A sheet as a grid of `{ "B7": value }`, which is how a person reads one. */
function sheetOf(name, cells, rowCount) {
  return {
    name,
    rowCount,
    cell: (row, column) => {
      const v = cells[`${column}${row}`];
      return v === undefined ? null : v;
    },
  };
}

// Row 3 is the header; rows 4-6 are data. Row 7 is a spacer with no retailer.
const SHEET = sheetOf("Vic", {
  A3: "Retailer", B3: "Jurisdiction", C3: "Residential customers", D3: "Disconnections",
  A4: "AGL", B4: "VIC", C4: 1000, D4: 12,
  A5: "Origin", B5: "VIC", C5: 2000, D5: "",       // blank must not become 0
  A6: "ENGIE", B6: "VIC", C6: "1,234", D6: "n/a",  // separators parse; n/a does not
  A7: "", B7: "", C7: 999, D7: 999,                // no retailer: not data
}, 7);

const MAPPING = {
  headerRow: 3,
  dimensions: { retailer: "A", jurisdiction: "B" },
  metrics: [
    { column: "C", raw: "Residential customers", metric: "residential_customers" },
    { column: "D", raw: "Disconnections", metric: "disconnections" },
  ],
};

console.log("Reading values out of a sheet:");
{
  const rows = extractRows(SHEET, MAPPING);
  const find = (r, m) => rows.find((x) => x.retailer === r && x.metric === m);

  check("reads a plain number", find("AGL", "residential_customers")?.value === 1000);
  check("carries the dimension", find("AGL", "residential_customers")?.jurisdiction === "VIC");
  check("records the cell it came from", find("AGL", "disconnections")?.cellRef === "D4",
    JSON.stringify(find("AGL", "disconnections")));
  check("parses a thousands separator", find("ENGIE", "residential_customers")?.value === 1234);

  // The two that would quietly fabricate data.
  check("a blank cell is skipped, NOT read as 0", find("Origin", "disconnections") === undefined,
    JSON.stringify(find("Origin", "disconnections")));
  check("\"n/a\" is skipped, NOT read as 0", find("ENGIE", "disconnections") === undefined,
    JSON.stringify(find("ENGIE", "disconnections")));
  check("a row with no retailer is not data", !rows.some((r) => r.value === 999));
  check("emits exactly the real observations", rows.length === 4, `got ${rows.length}: ${JSON.stringify(rows.map((r) => r.cellRef))}`);
}

console.log("Refusing to coerce:");
{
  check("empty string is null", numericValue("") === null);
  check("a dash is null, not 0", numericValue("—") === null);
  check("zero is still zero", numericValue(0) === 0);
  check("a percentage becomes a fraction", numericValue("12.5%") === 0.125);
  check("text is null", numericValue("see note 4") === null);
}

console.log("Rejecting a mapping that does not match the sheet:");
{
  check("a good mapping has no problems", mappingProblems(SHEET, MAPPING).length === 0,
    mappingProblems(SHEET, MAPPING).join("; "));

  // Off by one into the data: the header cells hold numbers, which is the
  // tell. An "is it empty" check alone misses this, because a data row is not
  // empty — and left alone it reads the whole sheet against measurements.
  const offByOne = { ...MAPPING, headerRow: 4 };
  check("a header row pointing at data is caught",
    mappingProblems(SHEET, offByOne).some((p) => p.includes("points at data")),
    mappingProblems(SHEET, offByOne).join("; "));

  // Off by one the other way, into a blank row above the header.
  const blankHeader = { ...MAPPING, headerRow: 2 };
  check("a header row pointing at a blank row is caught",
    mappingProblems(SHEET, blankHeader).some((p) => p.includes("is empty there")),
    mappingProblems(SHEET, blankHeader).join("; "));

  const missingColumn = { ...MAPPING, metrics: [...MAPPING.metrics, { column: "Z", raw: "Ghost", metric: "ghost" }] };
  check("a column with no header is caught",
    mappingProblems(SHEET, missingColumn).some((p) => p.includes("Z")),
    mappingProblems(SHEET, missingColumn).join("; "));

  const noRetailer = { ...MAPPING, dimensions: { retailer: "" } };
  check("a missing retailer dimension is caught",
    mappingProblems(SHEET, noRetailer).some((p) => p.includes("retailer")));

  const past = { ...MAPPING, headerRow: 99 };
  check("a header row past the end is caught",
    mappingProblems(SHEET, past).some((p) => p.includes("past the end")));

  const dupe = { ...MAPPING, metrics: [MAPPING.metrics[0], { column: "C", raw: "Again", metric: "again" }] };
  check("the same column mapped twice is caught",
    mappingProblems(SHEET, dupe).some((p) => p.includes("more than once")));
}

// The case the whole canonical/raw split exists for.
console.log("A renamed column stays one series:");
{
  const laterSheet = sheetOf("Vic", {
    A3: "Retailer", B3: "Jurisdiction", C3: "Residential customer numbers",
    A4: "AGL", B4: "VIC", C4: 1100,
  }, 4);
  // The inference step is shown the known vocabulary and matches the rename to
  // it; here that decision is made explicitly so the storage behaviour is
  // pinned without a model in the loop.
  const laterMapping = {
    headerRow: 3,
    dimensions: { retailer: "A", jurisdiction: "B" },
    metrics: [{ column: "C", raw: "Residential customer numbers", metric: "residential_customers" }],
  };

  const before = extractRows(SHEET, MAPPING).find((r) => r.retailer === "AGL" && r.metric === "residential_customers");
  const after = extractRows(laterSheet, laterMapping)[0];

  check("both quarters carry the same canonical metric", before.metric === after.metric,
    `${before.metric} vs ${after.metric}`);
  check("each keeps the header its own workbook used",
    before.metricRaw === "Residential customers" && after.metricRaw === "Residential customer numbers",
    `${before.metricRaw} | ${after.metricRaw}`);
  // A split series sums low — that is the damage, so that is the assertion.
  check("the series sums across the rename", before.value + after.value === 2100);
}

console.log("Canonical keys and periods:");
{
  check("a header becomes a stable key", canonicalMetric("Residential customers") === "residential_customers",
    canonicalMetric("Residential customers"));
  check("punctuation and case do not change the key",
    canonicalMetric("  Residential Customers (no.) ") === canonicalMetric("residential customers no"),
    `${canonicalMetric("  Residential Customers (no.) ")} vs ${canonicalMetric("residential customers no")}`);

  const q3 = periodBounds("2023-24 Q3");
  check("a quarter label resolves to its bounds",
    q3?.start === "2024-01-01" && q3?.end === "2024-03-31", JSON.stringify(q3));
  const q1 = periodBounds("2023-24 Q1");
  check("Q1 is the September quarter of the first year",
    q1?.start === "2023-07-01" && q1?.end === "2023-09-30", JSON.stringify(q1));
  check("an unparseable label is null, not a guess", periodBounds("sometime") === null);
}

// A workbook fetched by URL goes through the same checked fetcher a PDF does.
// What must not blur is which kind it is: the PDF allowlist gates the document
// pipeline, and a spreadsheet admitted to it fails deep inside createMarkdown
// rather than at the door.
console.log("Fetching a workbook is not fetching a document:");
{
  check("keeps the workbook's own name, .xlsm included",
    fileNameFromUrl("https://host/f/schedule-3-2024-25-q3.xlsm", "fallback", SPREADSHEET_KIND)
      === "schedule-3-2024-25-q3.xlsm",
    fileNameFromUrl("https://host/f/schedule-3-2024-25-q3.xlsm", "fallback", SPREADSHEET_KIND));
  check("a link with no file name falls back to .xlsx",
    fileNameFromUrl("https://host/download?id=7", "schedule-3-2024-25 Q3", SPREADSHEET_KIND)
      === "schedule-3-2024-25 Q3.xlsx",
    fileNameFromUrl("https://host/download?id=7", "schedule-3-2024-25 Q3", SPREADSHEET_KIND));
  check("a .pdf link is not a workbook name",
    fileNameFromUrl("https://host/f/guide.pdf", "fallback", SPREADSHEET_KIND) === "fallback.xlsx",
    fileNameFromUrl("https://host/f/guide.pdf", "fallback", SPREADSHEET_KIND));
  check("the PDF path is unchanged for its own callers",
    fileNameFromUrl("https://host/f/guide.pdf", "title") === "guide.pdf");

  check("an .xlsm is stored as macro-enabled, not as a plain sheet",
    SPREADSHEET_KIND.contentTypeFor("a.XLSM") === ALLOWED_SPREADSHEET_CONTENT_TYPES[1],
    SPREADSHEET_KIND.contentTypeFor("a.XLSM"));
  check("an .xlsx is stored as a sheet",
    SPREADSHEET_KIND.contentTypeFor("a.xlsx") === ALLOWED_SPREADSHEET_CONTENT_TYPES[0]);
  check("a PDF is still stored as a PDF",
    PDF_KIND.contentTypeFor("a.pdf") === ALLOWED_UPLOAD_CONTENT_TYPES[0]);

  // The split that keeps the two pipelines apart.
  check("neither kind accepts the other's content types",
    !SPREADSHEET_KIND.contentTypes.some((t) => PDF_KIND.contentTypes.includes(t)));
  check("a workbook does not land in uploads/",
    SPREADSHEET_KIND.pathname("a.xlsx").startsWith("schedules/") &&
      PDF_KIND.pathname("a.pdf").startsWith("uploads/"),
    `${SPREADSHEET_KIND.pathname("a.xlsx")} | ${PDF_KIND.pathname("a.pdf")}`);
}

console.log(failures === 0 ? "\nAll AER parsing checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
