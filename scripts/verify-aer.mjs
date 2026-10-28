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
import { readFileSync } from "node:fs";
import { canonicalRetailer } from "@/lib/aerDimensions";
import {
  extractRows,
  mappingProblems,
  numericValue,
} from "@/lib/sheetMapping";
import {
  canonicalMetric,
  isAnnualPeriodLabel,
  observationCollisions,
  observationKey,
  periodBounds,
  scopeTotals,
} from "@/lib/aerPerformance";
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
  metricRow: 3,
  periodRow: 0,
  dimensions: { retailer: "A", jurisdiction: "B" },
  metrics: [
    { column: "C", raw: "Residential customers", metric: "residential_customers" },
    { column: "D", raw: "Disconnections", metric: "disconnections" },
  ],
};

console.log("Reading values out of a sheet:");
{
  const rows = extractRows(SHEET, MAPPING);
  // Rows are keyed by the *canonical* retailer now, so look them up by the raw
  // string the sheet used and let canonicalRetailer do the matching — the same
  // thing a caller does. See verify:aer-consistency for the folding itself.
  const find = (r, m) =>
    rows.find((x) => x.retailer === canonicalRetailer(r) && x.metric === m);

  check("reads a plain number", find("AGL", "residential_customers")?.value === 1000);
  check("carries the dimension", find("AGL", "residential_customers")?.jurisdiction === "VIC");
  check("records the cell it came from", find("AGL", "disconnections")?.cellRef === "D4",
    JSON.stringify(find("AGL", "disconnections")));
  check("parses a thousands separator", find("ENGIE", "residential_customers")?.value === 1234);
  // Both halves travel: the key that is filtered on, and the string the sheet
  // actually used, which is the only thing a wrong fold can be recomputed from.
  check("the canonical key is stored, not the sheet's spelling",
    find("AGL", "residential_customers")?.retailer === "agl",
    find("AGL", "residential_customers")?.retailer);
  check("and the sheet's spelling is kept beside it",
    find("AGL", "residential_customers")?.retailerRaw === "AGL");
  check("the jurisdiction is canonical too, with its raw string",
    find("AGL", "disconnections")?.jurisdiction === "VIC" &&
      find("AGL", "disconnections")?.jurisdictionRaw === "VIC");

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
  const offByOne = { ...MAPPING, metricRow: 4 };
  check("a metric row pointing at data is caught",
    mappingProblems(SHEET, offByOne).some((p) => p.includes("points at data")),
    mappingProblems(SHEET, offByOne).join("; "));

  // Off by one the other way, into a blank row above the header.
  const blankHeader = { ...MAPPING, metricRow: 2 };
  check("a metric row pointing at a blank row is caught",
    mappingProblems(SHEET, blankHeader).some((p) => p.includes("is empty there")),
    mappingProblems(SHEET, blankHeader).join("; "));

  const missingColumn = { ...MAPPING, metrics: [...MAPPING.metrics, { column: "Z", raw: "Ghost", metric: "ghost" }] };
  check("a column with no header is caught",
    mappingProblems(SHEET, missingColumn).some((p) => p.includes("Z")),
    mappingProblems(SHEET, missingColumn).join("; "));

  const noRetailer = { ...MAPPING, dimensions: { retailer: "" } };
  check("a missing retailer dimension is caught",
    mappingProblems(SHEET, noRetailer).some((p) => p.includes("retailer")));

  const past = { ...MAPPING, metricRow: 99 };
  check("a metric row past the end is caught",
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
    metricRow: 3,
    periodRow: 0,
    dimensions: { retailer: "A", jurisdiction: "B" },
    metrics: [{ column: "C", raw: "Residential customer numbers", metric: "residential_customers" }],
  };

  const before = extractRows(SHEET, MAPPING).find(
    (r) => r.retailer === canonicalRetailer("AGL") && r.metric === "residential_customers"
  );
  const after = extractRows(laterSheet, laterMapping)[0];

  check("both quarters carry the same canonical metric", before.metric === after.metric,
    `${before.metric} vs ${after.metric}`);
  check("each keeps the header its own workbook used",
    before.metricRaw === "Residential customers" && after.metricRaw === "Residential customer numbers",
    `${before.metricRaw} | ${after.metricRaw}`);
  // A split series sums low — that is the damage, so that is the assertion.
  check("the series sums across the rename", before.value + after.value === 2100);
  // And the dimension has to fold too, or the rename is matched while the
  // retailer splits underneath it and the sum is wrong anyway.
  check("both quarters land on the same retailer key", before.retailer === after.retailer,
    `${before.retailer} vs ${after.retailer}`);
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

// The shape of a real workbook, transcribed from Schedule 2 Q4 2023-24.
// Everything above this point was written against a fixture that assumed one
// header row of metrics; the actual file does not look like that, and reading
// it the old way stored a real number from the wrong quarter under a
// correct-looking label. These are the checks that would have caught it.
console.log("The real two-header layout:");
{
  const REAL = sheetOf("Res Elec Cust#s & Mkt Contr", {
    A3: "Q4 2022-23 to Q4 2023-24", B3: "Electricity", C3: "Residential",
    A4: "National",
    B4: "Customer numbers", C4: "Customer numbers", D4: "Market share",
    A5: "Retailer", B5: "Q4 2022-23", C5: "Q4 2023-24", D5: "Q4 2023-24",
    A6: "AGL", B6: 1518827, C6: 1509284, D6: 0.2232,
    A7: "Alinta Energy", B7: 371681, C7: 315535, D7: 0.0546,
    A8: "Total", B8: 9999999, C8: 9999999, D8: 1,
  }, 8);

  const REAL_MAPPING = {
    metricRow: 4,
    periodRow: 5,
    dimensions: { retailer: "A" },
    sheetDimensions: { jurisdiction: "A4", fuel: "B3", customerType: "C3" },
    metrics: [
      { column: "B", raw: "Customer numbers", metric: "customer_numbers" },
      { column: "C", raw: "Customer numbers", metric: "customer_numbers" },
      { column: "D", raw: "Market share", metric: "market_share" },
    ],
  };

  check("the mapping is accepted", mappingProblems(REAL, REAL_MAPPING).length === 0,
    JSON.stringify(mappingProblems(REAL, REAL_MAPPING)));

  const rows = extractRows(REAL, REAL_MAPPING);
  const find = (r, m, p) =>
    rows.find((x) => x.retailer === canonicalRetailer(r) && x.metric === m && x.periodLabel === p);

  // THE bug. Two columns share the metric "Customer numbers" and differ only
  // by quarter. Read as one header row they collapse onto one key and one
  // silently overwrites the other.
  check("two columns of the same metric are two observations, not one",
    find("AGL", "customer_numbers", "2022-23 Q4")?.value === 1518827 &&
      find("AGL", "customer_numbers", "2023-24 Q4")?.value === 1509284,
    JSON.stringify(rows.filter((r) => r.metric === "customer_numbers").map((r) => [r.periodLabel, r.value])));

  // "Q4 2022-23" on the sheet is "2022-23 Q4" stored. Backwards, a quarter
  // lands under a label that parses but means different months.
  check("the sheet's quarter-first label is normalised",
    rows.every((r) => /^\d{4}-\d{2} Q[1-4]$/.test(r.periodLabel)),
    JSON.stringify([...new Set(rows.map((r) => r.periodLabel))]));

  // Dimensions above the table, not in columns.
  check("fuel comes from B3", find("AGL", "customer_numbers", "2023-24 Q4")?.fuel === "electricity");
  check("customer segment comes from C3",
    find("AGL", "customer_numbers", "2023-24 Q4")?.customerType === "residential");
  // This assertion used to expect null, on the reasoning that "National" is an
  // aggregate and an aggregate must not be stored. It was wrong, and it was
  // the bug: a null jurisdiction is what let every block in a 323-row sheet
  // share one observation key, so the last block written stood for all of
  // them — AGL's national figure became its South Australian Tier 1 figure.
  //
  // And the premise does not hold. The jurisdiction blocks do not sum to the
  // national row, because the AER does not break out Victoria. So National
  // carries customers that appear in no other row and is not recomputable.
  check("jurisdiction in A4 is stored as NATIONAL, not nulled out",
    find("AGL", "customer_numbers", "2023-24 Q4")?.jurisdiction === "NATIONAL",
    JSON.stringify(find("AGL", "customer_numbers", "2023-24 Q4")));
  check("and its raw spelling is kept",
    find("AGL", "customer_numbers", "2023-24 Q4")?.jurisdictionRaw === "National",
    JSON.stringify(find("AGL", "customer_numbers", "2023-24 Q4")?.jurisdictionRaw));
  check("and the raw strings are kept",
    find("AGL", "customer_numbers", "2023-24 Q4")?.fuelRaw === "Electricity" &&
      find("AGL", "customer_numbers", "2023-24 Q4")?.customerTypeRaw === "Residential");

  check("the total row is still refused", !rows.some((r) => r.value === 9999999));
  // 2 retailers x 3 columns.
  check("every real cell becomes one observation", rows.length === 6,
    `got ${rows.length}: ${JSON.stringify(rows.map((r) => [r.cellRef, r.periodLabel]))}`);
  check("provenance points at the actual cell",
    find("AGL", "market_share", "2023-24 Q4")?.cellRef === "D6");
}

console.log("Refusing a two-header mapping that does not hold:");
{
  const REAL = sheetOf("s", {
    A4: "National", B4: "Customer numbers", A5: "Retailer", B5: "Q4 2023-24",
    A6: "AGL", B6: 100,
  }, 6);
  const base = {
    metricRow: 4, periodRow: 5, dimensions: { retailer: "A" },
    metrics: [{ column: "B", raw: "Customer numbers", metric: "customer_numbers" }],
  };
  check("a good one passes", mappingProblems(REAL, base).length === 0,
    JSON.stringify(mappingProblems(REAL, base)));
  // One row cannot be both the measure and the quarter; accepting it would
  // reintroduce the collapse.
  check("periodRow equal to metricRow is refused",
    mappingProblems(REAL, { ...base, periodRow: 4 }).some((p) => /cannot be both/.test(p)),
    JSON.stringify(mappingProblems(REAL, { ...base, periodRow: 4 })));
  check("a period row pointing somewhere with no quarter is refused",
    mappingProblems(REAL, { ...base, periodRow: 6 }).some((p) => /period|quarter/i.test(p)),
    JSON.stringify(mappingProblems(REAL, { ...base, periodRow: 6 })));
  // A sheet-level dimension pointing at an empty cell reads as "the sheet says
  // nothing" when the truth is "we looked in the wrong place".
  check("a sheet dimension pointing at an empty cell is refused",
    mappingProblems(REAL, { ...base, sheetDimensions: { fuel: "Z9" } })
      .some((p) => /empty/.test(p)),
    JSON.stringify(mappingProblems(REAL, { ...base, sheetDimensions: { fuel: "Z9" } })));
  check("a sheet dimension that is not a cell reference is refused",
    mappingProblems(REAL, { ...base, sheetDimensions: { fuel: "B" } })
      .some((p) => /cell reference/.test(p)));
  // periodRow 0 is the single-period shape some sheets in the same workbook
  // still use, and must keep working.
  check("periodRow 0 still means one period from the release",
    extractRows(REAL, { ...base, metricRow: 4, periodRow: 0 })[0]?.periodLabel === null);
}


console.log("The annual block to the right of the quarterly one:");
{
  // The shape that refused all six of Schedule 2's main sheets on the first
  // real ingest. Rows 4/5 are the metric and period headers; B-C are quarters
  // and D-E are financial years, which is how the real sheets look once you
  // read past column 40 — where the fixture used to stop, which is exactly
  // why this went unseen.
  const cells = {
    A4: "National", B4: "Customer numbers", C4: "Customer numbers",
    D4: "Customer numbers", E4: "Customer numbers",
    A5: "Retailer", B5: "Q3 2023-24", C5: "Q4 2023-24", D5: "2022-23", E5: "2023-24",
    A6: "AGL", B6: 305354, C6: 301122, D6: 1200000, E6: 1210000,
    A7: "ACT Total", B7: 198786, C7: 197001, D7: 790000, E7: 795000,
  };
  const sheet = sheetOf("Res Elec Cust#s & Mkt Contr", cells, 7);
  const mapping = {
    metricRow: 4,
    periodRow: 5,
    dimensions: { retailer: "A" },
    sheetDimensions: {},
    metrics: ["B", "C", "D", "E"].map((column) => ({
      column, raw: "Customer numbers", metric: "customer_numbers",
    })),
  };

  check("a bare financial year is recognised as annual", isAnnualPeriodLabel("2022-23"));
  check("and with a four-digit tail", isAnnualPeriodLabel("2022-2023"));
  check("and when a header dresses it up", isAnnualPeriodLabel("FY 2022-23"));
  check("a quarter is NOT annual", !isAnnualPeriodLabel("Q4 2023-24"));
  check("nor is the stored form", !isAnnualPeriodLabel("2023-24 Q4"));
  check("nor is something unreadable", !isAnnualPeriodLabel("see note 4"));

  const problems = mappingProblems(sheet, mapping);
  check("the mapping is accepted despite the annual columns",
    problems.length === 0, JSON.stringify(problems));

  const rows = extractRows(sheet, mapping);
  const periods = [...new Set(rows.map((r) => r.periodLabel))].sort();
  check("only the quarterly columns produce rows",
    periods.length === 2 && periods[0] === "2023-24 Q3" && periods[1] === "2023-24 Q4",
    JSON.stringify(periods));
  check("the annual values are nowhere in the output",
    !rows.some((r) => r.value === 1200000 || r.value === 1210000),
    JSON.stringify(rows.map((r) => r.value)));
  check("AGL's two quarters carry the cell values",
    rows.some((r) => r.retailerRaw === "AGL" && r.value === 305354) &&
      rows.some((r) => r.retailerRaw === "AGL" && r.value === 301122),
    JSON.stringify(rows));
  check("the jurisdiction subtotal row is refused",
    !rows.some((r) => /act/i.test(r.retailerRaw)),
    JSON.stringify(rows.map((r) => r.retailerRaw)));
  check("so AGL is the only retailer left",
    new Set(rows.map((r) => r.retailerRaw)).size === 1,
    JSON.stringify([...new Set(rows.map((r) => r.retailerRaw))]));

  // Relaxing for the annual block must not relax for an unreadable header.
  const brokenSheet = sheetOf("broken", { ...cells, F4: "Customer numbers", F5: "whenever" }, 7);
  const broken = {
    ...mapping,
    metrics: [...mapping.metrics, { column: "F", raw: "Customer numbers", metric: "customer_numbers" }],
  };
  check("an unreadable period still fails the sheet",
    mappingProblems(brokenSheet, broken).some((x) => /not a quarter/.test(x)),
    JSON.stringify(mappingProblems(brokenSheet, broken)));
}

// ---------------------------------------------------------------------------
// A count and a percentage are two metrics
// ---------------------------------------------------------------------------
// Found by reconciling an ingest's own numbers: 57,786 observations extracted
// from Schedule 2, 45,876 stored. The missing 11,910 were columns that wrote
// an observation key another column had already written, so the uniqueness
// index kept the later one — the same class of silent overwrite as the stacked
// blocks, one layer down.
//
// The cause was `canonicalMetric` stripping `%` with the rest of the
// punctuation, which made a count column and its percentage column one key on
// the "Types of contracts" sheet. Twelve metrics lost one of each pair, and
// what survived was the ratio: AGL's national residential deemed-contract
// figure read 0.0033 where a customer count belonged.
{
  console.log("\na count and a percentage are two metrics");

  check("a percentage header does not collapse onto its count",
    canonicalMetric("Electricity Residential Contracts % Deemed") !==
      canonicalMetric("Electricity Residential Contracts Deemed"),
    canonicalMetric("Electricity Residential Contracts % Deemed"));
  check("and says which one it is rather than dropping the unit",
    canonicalMetric("Electricity Residential Contracts % Deemed")
      .includes("pct"),
    canonicalMetric("Electricity Residential Contracts % Deemed"));
  check("a trailing % is kept too",
    canonicalMetric("Customers on market contracts %") !==
      canonicalMetric("Customers on market contracts"),
    canonicalMetric("Customers on market contracts %"));
  check("a header with no % keeps the key it always had",
    canonicalMetric("Customer numbers") === "customer_numbers",
    canonicalMetric("Customer numbers"));

  // The structural guard, which would have caught the above whatever caused
  // it. A single-period sheet with two columns claiming one metric.
  const cells = {
    A4: "National",
    B4: "Contracts Deemed", C4: "Contracts Deemed",
    A5: "AGL", B5: 5066, C5: 0.0033,
  };
  const sheet = sheetOf("Types of contracts", cells, 5);
  const collide = {
    metricRow: 4,
    periodRow: 0,
    dimensions: { retailer: "A" },
    sheetDimensions: {},
    metrics: [
      { column: "B", raw: "Contracts Deemed", metric: "contracts_deemed" },
      { column: "C", raw: "Contracts % Deemed", metric: "contracts_deemed" },
    ],
  };
  const problems = mappingProblems(sheet, collide);
  check("two columns claiming one metric is refused, not written half-read",
    problems.some((x) => /both map to metric/.test(x)), JSON.stringify(problems));
  check("and the message names both columns so the mapping can be fixed",
    problems.some((x) => /columns B and C/.test(x)), JSON.stringify(problems));

  // The same metric in several columns is the *normal* shape when the columns
  // are quarters, so the guard must key on the period as well. Getting this
  // wrong would refuse every main sheet in the workbook.
  const quarterly = {
    ...collide,
    periodRow: 5,
    metrics: [
      { column: "B", raw: "Contracts Deemed", metric: "contracts_deemed" },
      { column: "C", raw: "Contracts Deemed", metric: "contracts_deemed" },
    ],
  };
  const quarterlySheet = sheetOf("Types of contracts", {
    A4: "National", B4: "Contracts Deemed", C4: "Contracts Deemed",
    A5: "Retailer", B5: "Q3 2023-24", C5: "Q4 2023-24",
    A6: "AGL", B6: 5066, C6: 5100,
  }, 6);
  check("the same metric in two different quarters is not a collision",
    !mappingProblems(quarterlySheet, quarterly).some((x) => /both map to metric/.test(x)),
    JSON.stringify(mappingProblems(quarterlySheet, quarterly)));
}

// ---------------------------------------------------------------------------
// A dimension stated across column groups
// ---------------------------------------------------------------------------
// Observed, not constructed. This is the header band of `Switch# Standard to
// Market` in the real Q4 2023-24 workbook, read with ExcelJS from the file
// itself:
//
//   r3: A3="Q4 2022-23 to Q4 2023-24" ; B3=Electricity ;             AJ3=Gas
//   r4: B4..K4=Residential ; M4..V4=Small Business ; X4..AG4=Large ; AJ4=Residential
//   r5: the measure, repeated per quarter
//   r6: the quarter per column
//
// Four header levels where the mapping modelled two. Read without row 4, the
// Residential, Small Business and Large groups all write the same
// (retailer, metric, period) key and two thirds of a 67-column sheet is
// overwritten with no error — the stacked-block failure turned ninety
// degrees. Six of Schedule 2's fifteen sheets hit this.
//
// Note the two spellings the AER mixes within one sheet: row 4 repeats its
// label in every column, row 3 writes it once and leaves the rest of the
// group empty. So a column's value is the nearest label at or to its left.
{
  console.log("\na dimension across column groups");

  // Faithful miniature: three groups of two quarters. Fuel is written once
  // per group (B3, F3) and customer type in every column, exactly as the real
  // sheet mixes them.
  const cells = {
    B3: "Electricity", F3: "Gas",
    B4: "Residential", C4: "Residential",
    D4: "Small Business", E4: "Small Business",
    F4: "Residential", G4: "Residential",
    B5: "Standard to Market", C5: "Standard to Market", D5: "Standard to Market",
    E5: "Standard to Market", F5: "Standard to Market", G5: "Standard to Market",
    A6: "Retailer",
    B6: "Q3 2023-24", C6: "Q4 2023-24", D6: "Q3 2023-24",
    E6: "Q4 2023-24", F6: "Q3 2023-24", G6: "Q4 2023-24",
    A7: "AGL", B7: 11, C7: 12, D7: 21, E7: 22, F7: 31, G7: 32,
  };
  const sheet = sheetOf("Switch# Standard to Market", cells, 7);
  const base = {
    metricRow: 5, periodRow: 6,
    dimensions: { retailer: "A" }, sheetDimensions: {},
    metrics: ["B", "C", "D", "E", "F", "G"].map((column) => ({
      column, raw: "Standard to Market", metric: "standard_to_market",
    })),
  };

  // Without the group rows this is a guaranteed collision, and must be said.
  const blind = mappingProblems(sheet, base);
  check("without the group rows the collision is refused",
    blind.some((x) => /both map to metric/.test(x)), JSON.stringify(blind.slice(0, 2)));
  check("and the complaint points at the fix",
    blind.some((x) => /dimensionRows/.test(x)), JSON.stringify(blind.slice(0, 1)));

  const mapping = { ...base, dimensionRows: { fuel: 3, customerType: 4 } };
  check("with them the mapping is accepted",
    mappingProblems(sheet, mapping).length === 0,
    JSON.stringify(mappingProblems(sheet, mapping)));

  const rows = extractRows(sheet, mapping);
  check("every column produces its own observation",
    rows.length === 6, JSON.stringify(rows.length));

  const keyed = new Map(
    rows.map((r) => [`${r.fuel}/${r.customerType}/${r.periodLabel}`, r.value])
  );
  check("each group carries its own fuel and customer segment",
    keyed.get("electricity/residential/2023-24 Q3") === 11 &&
      keyed.get("electricity/residential/2023-24 Q4") === 12 &&
      keyed.get("electricity/small_business/2023-24 Q3") === 21 &&
      keyed.get("electricity/small_business/2023-24 Q4") === 22 &&
      keyed.get("gas/residential/2023-24 Q3") === 31 &&
      keyed.get("gas/residential/2023-24 Q4") === 32,
    JSON.stringify([...keyed]));

  // The carry-forward is the part that is easy to get wrong: C3 and D3 are
  // empty, and those columns are still Electricity.
  check("a column with an empty group cell looks left, not up",
    keyed.get("electricity/small_business/2023-24 Q3") === 21,
    JSON.stringify([...keyed]));
  check("and the raw spelling is kept, as every other dimension does",
    rows.every((r) => r.fuelRaw === "Electricity" || r.fuelRaw === "Gas"),
    JSON.stringify(rows.map((r) => r.fuelRaw)));

  // It must not reach past the table into whatever sits left of the metrics.
  const bounded = sheetOf("Switch# Standard to Market", { ...cells, A3: "Q4 2022-23 to Q4 2023-24" }, 7);
  check("the carry-forward stops at the first mapped column",
    extractRows(bounded, mapping).every((r) => r.fuel === "electricity" || r.fuel === "gas"),
    JSON.stringify(extractRows(bounded, mapping).map((r) => r.fuelRaw)));

  // One metric with a dimension, not six metrics. Folding the segment into
  // the measure name would split a series that the schema can hold whole.
  check("it stays one metric across all six columns",
    new Set(rows.map((r) => r.metric)).size === 1,
    JSON.stringify([...new Set(rows.map((r) => r.metric))]));
}

// ---------------------------------------------------------------------------
// A sheet can parse cleanly and still yield nothing
// ---------------------------------------------------------------------------
// These shapes are constructed, not observed — unlike the block fixtures,
// which come from real workbooks. They stand for cases I can reason about
// before meeting Schedule 3's 29 sheets, and the point of each is that
// `mappingProblems` is *empty* while `extractRows` returns nothing: the one
// combination that raises no error and leaves no gap to see. `extractAndStore`
// now names such a sheet rather than counting it among the ones that parsed.
{
  console.log("\nsheets that parse and yield nothing");

  // Every column annual. Annual columns are deliberately not a mapping
  // failure — treating them as one cost all six of Schedule 2's main sheets —
  // so a sheet that is *only* annual passes validation and produces no rows.
  // Schedule 3's "SA Service Standards" is mixed, but nothing guarantees the
  // next one is.
  const annualOnly = sheetOf("SA Service Standards", {
    A4: "National", B4: "Complaints", C4: "Complaints",
    A5: "Retailer", B5: "2022-23", C5: "2023-24",
    A6: "AGL", B6: 1200, C6: 1310,
  }, 6);
  const annualMapping = {
    metricRow: 4, periodRow: 5,
    dimensions: { retailer: "A" }, sheetDimensions: {},
    metrics: [
      { column: "B", raw: "Complaints", metric: "complaints" },
      { column: "C", raw: "Complaints", metric: "complaints" },
    ],
  };
  check("an all-annual sheet is not a mapping failure",
    mappingProblems(annualOnly, annualMapping).length === 0,
    JSON.stringify(mappingProblems(annualOnly, annualMapping)));
  check("and yields no rows, which is why the step has to name it",
    extractRows(annualOnly, annualMapping).length === 0,
    JSON.stringify(extractRows(annualOnly, annualMapping)));

  // Every data row an aggregate. `isAggregateLabel` refuses each one, so the
  // sheet is read correctly and contributes nothing.
  const totalsOnly = sheetOf("Totals", {
    A4: "National", B4: "Complaints",
    A5: "Retailer", B5: "Q4 2023-24",
    A6: "Total", B6: 50, A7: "All retailers", B7: 50, A8: "Grand total", B8: 100,
  }, 8);
  const totalsMapping = {
    metricRow: 4, periodRow: 5,
    dimensions: { retailer: "A" }, sheetDimensions: {},
    metrics: [{ column: "B", raw: "Complaints", metric: "complaints" }],
  };
  check("a sheet of nothing but aggregate rows yields no rows",
    extractRows(totalsOnly, totalsMapping).length === 0,
    JSON.stringify(extractRows(totalsOnly, totalsMapping)));
  check("and is not reported as a broken mapping either",
    mappingProblems(totalsOnly, totalsMapping).length === 0,
    JSON.stringify(mappingProblems(totalsOnly, totalsMapping)));
}

// ---------------------------------------------------------------------------
// Shapes other than stacked blocks
// ---------------------------------------------------------------------------
// Also constructed. Schedule 3 reports some measures with the jurisdiction in
// a column rather than in block headers, and not every sheet puts the retailer
// in column A.
{
  console.log("\nother sheet shapes");

  const byColumn = sheetOf("Disconnections Resi", {
    A3: "Retailer", B3: "State", C3: "Disconnections",
    A4: "AGL", B4: "Victoria", C4: 1200,
    A5: "AGL", B5: "New South Wales", C5: 2400,
    A6: "Origin Energy", B6: "QLD", C6: 900,
  }, 6);
  const byColumnMapping = {
    metricRow: 3, periodRow: 0,
    dimensions: { retailer: "A", jurisdiction: "B" },
    sheetDimensions: {},
    metrics: [{ column: "C", raw: "Disconnections", metric: "disconnections" }],
  };
  const rows = extractRows(byColumn, byColumnMapping);
  check("a jurisdiction column produces one row per jurisdiction",
    rows.length === 3, JSON.stringify(rows.map((r) => r.jurisdictionRaw)));
  check("and canonicalises the spelling the sheet used",
    rows.map((r) => r.jurisdiction).join(",") === "VIC,NSW,QLD",
    JSON.stringify(rows.map((r) => r.jurisdiction)));
  check("while keeping that spelling verbatim",
    rows[1]?.jurisdictionRaw === "New South Wales", rows[1]?.jurisdictionRaw);

  // A column wins over a sheet-level cell, which is what lets one workbook
  // mix both shapes. Asserted here because the block attribution made the
  // sheet-level cell a *seed*, and that must not have overridden a column.
  const withBoth = sheetOf("Disconnections Resi", {
    A1: "Tasmania",
    A3: "Retailer", B3: "State", C3: "Disconnections",
    A4: "AGL", B4: "Victoria", C4: 1200,
  }, 4);
  const bothMapping = {
    ...byColumnMapping,
    sheetDimensions: { jurisdiction: "A1" },
  };
  check("a jurisdiction column still beats a sheet-level cell",
    extractRows(withBoth, bothMapping)[0]?.jurisdiction === "VIC",
    JSON.stringify(extractRows(withBoth, bothMapping)[0]));
}

// ---------------------------------------------------------------------------
// The run says what did not survive
// ---------------------------------------------------------------------------
// `replaceScheduleRows` inserts ON CONFLICT DO UPDATE, so a collision looks
// exactly like an insert from the statement's point of view. It reported
// `rows.length` as "written", a number that cannot be wrong in the direction
// that matters because it never looks — and a real ingest said 57,786 written
// against 45,876 rows in the table. The gap was found by reading two numbers
// side by side and noticing, which is not a mechanism. This is the mechanism.
{
  console.log("\nwhat did not survive");

  const row = (over) => ({
    schedule: 2, periodLabel: "2023-24 Q4", retailer: "agl",
    metric: "customer_numbers", jurisdiction: "NATIONAL", fuel: "electricity",
    customerType: "residential", sheetName: "Res Elec", cellRef: "F8", ...over,
  });

  const clean = observationCollisions([
    row(), row({ jurisdiction: "NSW", cellRef: "F101" }),
    row({ metric: "market_share", cellRef: "K8" }),
    row({ periodLabel: "2023-24 Q3", cellRef: "E8" }),
  ]);
  check("rows that differ in any key component do not collide",
    clean.distinct === 4 && clean.overwritten === 0, JSON.stringify(clean));

  // The real case: one sheet's count column and percentage column landing on
  // one key, which is what the % fix above stops at the source.
  const collided = observationCollisions([
    row({ cellRef: "H9" }), row({ cellRef: "I9" }), row({ cellRef: "J9" }),
  ]);
  check("rows sharing a key are counted, not silently absorbed",
    collided.overwritten === 2, JSON.stringify(collided));
  check("and only one of them is reported as written",
    collided.distinct === 1, JSON.stringify(collided));
  check("the example names the cell that overwrites and the one it overwrites",
    collided.examples[0]?.includes("I9") && collided.examples[0]?.includes("H9"),
    JSON.stringify(collided.examples));

  // A nullable dimension must behave the way COALESCE(…, '') does, or the
  // count reports collisions that will not happen and misses ones that will.
  check("a null dimension keys as the empty string, as the index COALESCEs it",
    observationKey(row({ fuel: null })) === observationKey(row({ fuel: "" })),
    observationKey(row({ fuel: null })));
  check("and is still distinct from a real value",
    observationKey(row({ fuel: null })) !== observationKey(row()));

  // The key is a copy of a database index, so it is checked against the
  // index's own source rather than against my memory of it. If someone adds a
  // dimension to the index, the reconciliation has to learn about it or it
  // silently goes back to counting attempts.
  const ddl = readFileSync(new URL("../db/aer_performance.sql", import.meta.url), "utf8");
  const idx = ddl.match(/aer_performance_observation_idx\s*\n?\s*ON aer_performance \(([\s\S]*?)\);/);
  check("the uniqueness index is still findable in the DDL", Boolean(idx));
  if (idx) {
    const components = idx[1]
      .replace(/COALESCE\(([a-z_]+),\s*''\)/g, "$1")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const expected = ["schedule", "period_label", "retailer", "metric",
      "jurisdiction", "fuel", "customer_type"];
    check("and names exactly the components observationKey builds from",
      components.length === expected.length &&
        components.every((c, i) => c === expected[i]),
      JSON.stringify(components));
  }
}

// ---------------------------------------------------------------------------
// A total that would double-count is not given
// ---------------------------------------------------------------------------
// The cost of keeping National as a jurisdiction rather than a null. The sum
// the tool advertises is exact, and a match set holding the national figure
// beside the per-jurisdiction ones sums to roughly double — high, plausible,
// and invisible, which is the one direction of error that nothing downstream
// can catch. Asserted here rather than against the database, because the
// decision is pure and the database is the part that cannot be checked in CI.
{
  console.log("\nscope totals");

  // AGL's national residential electricity count for 2022-23 Q4 beside its
  // jurisdiction blocks, as stored from the real workbook: 1,518,827 at B8,
  // and 809,019 + 402,908 + 306,896 + 4 across B101/B159/B217/B79 — the same
  // figure again, which is why the naive total is 3,037,654 and why it is
  // exactly twice the truth rather than merely somewhat high.
  const mixed = scopeTotals({
    totalCount: 6,
    nationalCount: 1,
    totalValue: 3_037_654,
    nationalValue: 1_518_827,
    subNationalValue: 1_518_827,
  });
  check("a match set mixing National with jurisdictions gives no single total",
    mixed.totalValue === null, JSON.stringify(mixed));
  check("and reports both halves rather than withholding the numbers",
    mixed.nationalValue === 1_518_827 && mixed.subNationalValue === 1_518_827,
    JSON.stringify(mixed));
  check("the doubled figure is nowhere in the result",
    !Object.values(mixed).includes(3_037_654), JSON.stringify(mixed));
  check("and the mix is flagged, not left to be inferred from a null",
    mixed.scopesMixed === true, JSON.stringify(mixed));

  const nationalOnly = scopeTotals({
    totalCount: 1,
    nationalCount: 1,
    totalValue: 1_518_827,
    nationalValue: 1_518_827,
    subNationalValue: null,
  });
  check("National on its own does total",
    nationalOnly.totalValue === 1_518_827 && nationalOnly.scopesMixed === false,
    JSON.stringify(nationalOnly));
  check("and does not claim a jurisdiction figure it has no rows for",
    nationalOnly.subNationalValue === null, JSON.stringify(nationalOnly));

  const statesOnly = scopeTotals({
    totalCount: 5,
    nationalCount: 0,
    totalValue: 1_518_827,
    nationalValue: null,
    subNationalValue: 1_518_827,
  });
  check("jurisdictions on their own do total",
    statesOnly.totalValue === 1_518_827 && statesOnly.scopesMixed === false,
    JSON.stringify(statesOnly));
  check("and do not claim a national figure they have no rows for",
    statesOnly.nationalValue === null, JSON.stringify(statesOnly));

  // "Nothing matched" must stay distinguishable from "a total would mislead":
  // one is zero, the other is null, and the tool renders them differently.
  const empty = scopeTotals({
    totalCount: 0, nationalCount: 0, totalValue: null, nationalValue: null, subNationalValue: null,
  });
  check("an empty match set totals zero rather than null",
    empty.totalValue === 0 && empty.scopesMixed === false, JSON.stringify(empty));
}

console.log(failures === 0 ? "\nAll AER parsing checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
