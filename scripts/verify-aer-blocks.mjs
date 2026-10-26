/**
 * Does one sheet's several tables stay several tables?
 *
 *   pnpm verify:aer-blocks
 *
 * Every AER data sheet is divided into blocks. `Res Elec Cust#s & Mkt Contr`
 * is 323 rows and holds, in order: a National table of all retailers, a
 * "Jurisdictions" divider, one table per jurisdiction, a "Tier 1 Retailers"
 * divider, and then the whole thing again for Tier 1 retailers only. The
 * jurisdiction is named in a header row above each block, in column A.
 *
 * `extractRows` did not know blocks existed. It read `sheetDimensions.
 * jurisdiction = "A4"` once — which names only the *first* block — stamped
 * "National" on all 323 rows, and `canonicalJurisdiction` correctly reduced
 * that aggregate to null. So every block shared one key:
 *
 *   (schedule, period, retailer, metric, jurisdiction=NULL, fuel, customer_type)
 *
 * and `aer_performance_observation_idx` collapsed eight tables into one. Last
 * block written won. AGL's national residential electricity customers were
 * stored as 306,896 — the figure from the South Australian block of the Tier 1
 * section — against 1,518,827 in the spreadsheet. An 80% understatement with a
 * cell reference attached, which is the exact failure mode `data-stores.md` is
 * written against: wrong, low, confident, invisible.
 *
 * Nothing caught it because the only fixture stopped at row 30 and column 40.
 * The first block header is at row 76. So this file exists to assert the
 * structure that was missed, against the structure as actually observed —
 * `fixtures/aer-sheet-blocks.json` is a transcript of real workbooks, not a
 * guess at them.
 *
 * Offline: no model, no network, no database.
 */
import fs from "node:fs";
import path from "node:path";
import { extractRows, mappingProblems } from "@/lib/sheetMapping";
import {
  JURISDICTIONS,
  NATIONAL,
  blockLabelKind,
  canonicalJurisdiction,
  isAggregateLabel,
} from "@/lib/aerDimensions";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
};

const blocks = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "scripts/fixtures/aer-sheet-blocks.json"), "utf8")
);

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

// ---------------------------------------------------------------------------
// What the real sheets look like
// ---------------------------------------------------------------------------
console.log("The observed structure, as a fact about the workbooks:");
{
  const resElec = blocks.sheets.find((s) => s.name === "Res Elec Cust#s & Mkt Contr");
  check("the sheet the ingest got wrong is in the fixture", Boolean(resElec));
  check(
    "it has more than one block, so it is not one flat table",
    resElec.blocks.length > 1,
    `${resElec.blocks.length} block headers`
  );
  check(
    "its first block header is below any row a 30-row fixture would reach",
    resElec.blocks.some(([row]) => row > 30),
    JSON.stringify(resElec.blocks.map(([r]) => r))
  );
  check(
    "its widest column is beyond the 40 the first fixture captured",
    resElec.widestColumn > "AN",
    `widest ${resElec.widestColumn}`
  );
  check(
    "every data sheet in the fixture is blocked, not flat",
    blocks.sheets.every((s) => s.blocks.length > 1),
    JSON.stringify(blocks.sheets.filter((s) => s.blocks.length <= 1).map((s) => s.name))
  );

  // The dividers are not jurisdictions and must not be treated as ones.
  check(
    '"Jurisdictions" is a divider, not a jurisdiction',
    canonicalJurisdiction("Jurisdictions") === null
  );
  check(
    '"Tier 1 Retailers" is a divider, not a jurisdiction',
    canonicalJurisdiction("Tier 1 Retailers") === null
  );
  check('"National" is an aggregate', isAggregateLabel("National"));
  // The five that are real, and Victoria's absence, which is correct.
  for (const j of ["ACT", "NSW", "QLD", "SA", "TAS"]) {
    check(`"${j}" canonicalises to a jurisdiction`, canonicalJurisdiction(j) !== null, j);
  }
  check(
    "Victoria is absent from these workbooks, which is correct",
    !blocks.sheets.some((s) => s.blocks.some(([, label]) => /^vic/i.test(label)))
  );
}

// ---------------------------------------------------------------------------
// The behaviour that has to hold
// ---------------------------------------------------------------------------
// A faithful miniature of `Res Elec`: a National block, a "Jurisdictions"
// divider, two jurisdiction blocks, a "Tier 1 Retailers" divider, and a Tier 1
// National block — with AGL in every one of them, at a different value. That
// repetition is the whole point: if blocks are not attributed, these rows
// collapse onto one key and only one survives.
console.log("\nAGL appears in every block, and must not collapse to one row:");
{
  const cells = {
    A3: "Q4 2022-23 to Q4 2023-24", B3: "Electricity", C3: "Residential",
    A4: "National",
    A5: "Retailer", B5: "Q3 2023-24", C5: "Q4 2023-24",
    B4: "Customer numbers", C4: "Customer numbers",

    // Block 1 — National, all retailers.
    A6: "AGL", B6: 1496817, C6: 1509284,
    A7: "Origin Energy", B7: 1000000, C7: 1010000,

    // Divider, then three jurisdiction blocks.
    A8: "Jurisdictions",
    A9: "ACT",
    A10: "AGL", B10: 50000, C10: 51000,
    A11: "NSW",
    A12: "AGL", B12: 400000, C12: 401000,
    A13: "SA",
    A14: "AGL", B14: 303627, C14: 305354,

    // Second section: the same jurisdictions again for a subset of retailers.
    // Everything from here on must be dropped — it would collide with the
    // full-population rows above and the schema cannot tell them apart.
    A15: "Tier 1 Retailers",
    A16: "National",
    A17: "AGL", B17: 1400000, C17: 1410000,
    A18: "SA",
    A19: "AGL", B19: 299000, C19: 299500,
  };
  const sheet = sheetOf("Res Elec Cust#s & Mkt Contr", cells, 19);
  const mapping = {
    metricRow: 4,
    periodRow: 5,
    dimensions: { retailer: "A" },
    sheetDimensions: { fuel: "B3", customerType: "C3", jurisdiction: "A4" },
    metrics: [
      { column: "B", raw: "Customer numbers", metric: "customer_numbers" },
      { column: "C", raw: "Customer numbers", metric: "customer_numbers" },
    ],
  };

  check("the mapping is accepted", mappingProblems(sheet, mapping).length === 0,
    JSON.stringify(mappingProblems(sheet, mapping)));

  const rows = extractRows(sheet, mapping);
  const agl = rows.filter((r) => r.retailer === "agl");

  // A divider is not a retailer.
  check(
    "no divider row is stored as a retailer",
    !rows.some((r) => /jurisdiction|tier/i.test(r.retailerRaw)),
    JSON.stringify([...new Set(rows.map((r) => r.retailerRaw))])
  );
  check(
    "no jurisdiction header is stored as a retailer",
    !rows.some((r) => ["ACT", "NSW", "SA", "National"].includes(r.retailerRaw)),
    JSON.stringify([...new Set(rows.map((r) => r.retailerRaw))])
  );

  // The ACT and NSW blocks must carry their own jurisdiction.
  const byJurisdiction = new Map();
  for (const r of agl) {
    const key = `${r.jurisdiction ?? "null"}`;
    if (!byJurisdiction.has(key)) byJurisdiction.set(key, []);
    byJurisdiction.get(key).push(r.value);
  }
  check(
    "AGL's ACT figures are attributed to ACT",
    agl.some((r) => r.jurisdiction === "ACT" && r.value === 51000),
    JSON.stringify(agl.map((r) => [r.jurisdiction, r.value]))
  );
  check(
    "AGL's NSW figures are attributed to NSW",
    agl.some((r) => r.jurisdiction === "NSW" && r.value === 401000),
    JSON.stringify(agl.map((r) => [r.jurisdiction, r.value]))
  );
  check(
    "AGL's SA figures are attributed to SA",
    agl.some((r) => r.jurisdiction === "SA" && r.value === 305354),
    JSON.stringify(agl.map((r) => [r.jurisdiction, r.value]))
  );

  // The failure exactly as it happened: the SA Tier 1 figure must not be the
  // one standing in for the whole country.
  check(
    "the SA figure is NOT filed with a null jurisdiction",
    !agl.some((r) => r.jurisdiction === null && r.value === 305354),
    "This is the bug: 305,354 is AGL in South Australia, stored as if national."
  );
  check(
    "no row at all carries a null jurisdiction",
    !agl.some((r) => r.jurisdiction === null),
    JSON.stringify(agl.map((r) => [r.jurisdiction, r.value]))
  );
  // National is stored rather than dropped, because the jurisdiction blocks do
  // not sum to it: the AER omits Victoria, so the national row carries
  // customers that appear nowhere else.
  check(
    "the National block is kept, with an explicit jurisdiction",
    agl.some((r) => r.jurisdiction === "NATIONAL" && r.value === 1509284),
    JSON.stringify(agl.map((r) => [r.jurisdiction, r.value]))
  );
  check(
    "and its raw spelling is the sheet's own",
    agl.some((r) => r.jurisdiction === "NATIONAL" && r.jurisdictionRaw === "National"),
    JSON.stringify(agl.map((r) => [r.jurisdiction, r.jurisdictionRaw]))
  );
  // Everything after the scope divider is dropped.
  check(
    "the Tier 1 section produces no rows",
    !agl.some((r) => [1400000, 1410000, 299000, 299500].includes(r.value)),
    JSON.stringify(agl.map((r) => [r.jurisdiction, r.value]))
  );

  // Blocks must produce distinct keys, which is what stops the collapse.
  const keys = agl.map((r) =>
    [r.periodLabel, r.retailer, r.metric, r.jurisdiction, r.fuel, r.customerType].join("|")
  );
  check(
    "every AGL row has a distinct observation key",
    new Set(keys).size === keys.length,
    `${keys.length} rows, ${new Set(keys).size} distinct keys:\n       ${keys.join("\n       ")}`
  );
  check(
    "which means more than one AGL row per quarter survives",
    agl.filter((r) => r.periodLabel === "2023-24 Q4").length > 1,
    `${agl.filter((r) => r.periodLabel === "2023-24 Q4").length} row(s) for Q4`
  );

  // The sheet-level dimensions that are genuinely sheet-level still apply.
  check(
    "fuel from B3 reaches every row",
    rows.length > 0 && rows.every((r) => r.fuel === "electricity"),
    JSON.stringify([...new Set(rows.map((r) => r.fuel))])
  );
  check(
    "customer segment from C3 reaches every row",
    rows.length > 0 && rows.every((r) => r.customerType === "residential"),
    JSON.stringify([...new Set(rows.map((r) => r.customerType))])
  );
}

// ---------------------------------------------------------------------------
// Can it be got back out again?
// ---------------------------------------------------------------------------
// `queryAer` canonicalises an incoming jurisdiction filter and compares it
// case-insensitively, so whatever a caller types has to land on the stored
// code. That path is newly load-bearing: NATIONAL is a value that did not
// exist before this change, and the jurisdiction column was null on every row
// ever stored, so no filter on it has ever actually matched anything.
console.log("\nRetrieving it: what a caller can type and still match:");
{
  check("NATIONAL is in the closed vocabulary, so a facet can list it",
    JURISDICTIONS.includes(NATIONAL), JSON.stringify(JURISDICTIONS));

  // Each of these is what a model or a person would plausibly send.
  for (const [typed, expected] of [
    ["National", "NATIONAL"],
    ["national", "NATIONAL"],
    ["NATIONAL", "NATIONAL"],
    ["Australia", "NATIONAL"],
    ["All jurisdictions", "NATIONAL"],
    ["NSW", "NSW"],
    ["nsw", "NSW"],
    ["New South Wales", "NSW"],
    ["ACT", "ACT"],
    ["Australian Capital Territory", "ACT"],
    ["SA", "SA"],
    ["South Australia", "SA"],
    ["Victoria", "VIC"],
  ]) {
    check(`a filter of "${typed}" resolves to ${expected}`,
      canonicalJurisdiction(typed) === expected,
      `got ${JSON.stringify(canonicalJurisdiction(typed))}`);
  }

  // And what must NOT resolve, so an unrecognised filter narrows to nothing
  // rather than quietly widening to everything.
  for (const typed of ["Jurisdictions", "Tier 1 Retailers", "somewhere", "Total"]) {
    check(`a filter of "${typed}" resolves to nothing`,
      canonicalJurisdiction(typed) === null,
      `got ${JSON.stringify(canonicalJurisdiction(typed))}`);
  }

  // The classifier's four kinds, since every block in every sheet goes
  // through it and an unknown is dropped rather than misattributed.
  check("a jurisdiction header classifies as one",
    blockLabelKind("NSW").kind === "jurisdiction");
  check("National classifies as a jurisdiction, not an aggregate to discard",
    blockLabelKind("National").kind === "jurisdiction" &&
      blockLabelKind("National").jurisdiction === "NATIONAL");
  check('"Jurisdictions" classifies as a divider',
    blockLabelKind("Jurisdictions").kind === "divider");
  check('"Tier 1 Retailers" classifies as a scope change',
    blockLabelKind("Tier 1 Retailers").kind === "scope");
  check('"Tier 2" does too, since the wording varies',
    blockLabelKind("Tier 2").kind === "scope");
  check("anything else is unknown, and its block is dropped",
    blockLabelKind("Some note about the data").kind === "unknown");
}

console.log(
  failures === 0
    ? "\nAll AER block checks passed."
    : `\n${failures} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
