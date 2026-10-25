// Keeping one series one series, across schemas that drift.
//
// `verify:aer` checks that the numbers read out of a sheet are the numbers
// that went in. This checks the layer that decides *which series a number
// belongs to* — and the two failures it prevents are different in kind:
//
//  1. A split. "Origin" one quarter and "Origin Energy" the next is one
//     retailer stored as two, and because the observation index keys on the
//     retailer they are two rows that never collide and never dedupe. Visible
//     as a gap, at least.
//  2. A double. A "Total" row stored as an observation is summed together
//     with the parts it totals, so every figure the tool reports comes back
//     roughly twice — with the exactness the tool advertises. Invisible.
//
// And the thing neither the rename trail nor the dimensions can see: a metric
// keeping its name while its definition moves.
//
// Pure: no network, no model, no database. Run: pnpm verify:aer-consistency
import {
  CUSTOMER_TYPES,
  FUELS,
  canonicalCustomerType,
  JURISDICTIONS,
  canonicalDimensions,
  canonicalFuel,
  canonicalJurisdiction,
  canonicalRetailer,
  isAggregateLabel,
} from "@/lib/aerDimensions";
import {
  classifyDefinitions,
  definitionKey,
  definitionProblem,
} from "@/lib/aerDefinitions";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n    ${detail}` : ""}`); }
};

console.log("One retailer, however the workbook spelled it:");
{
  const agl = canonicalRetailer("AGL Energy Ltd");
  check("a legal suffix does not make a second retailer",
    agl === canonicalRetailer("AGL Energy Limited") && agl === canonicalRetailer("agl energy"),
    [agl, canonicalRetailer("AGL Energy Limited"), canonicalRetailer("agl energy")].join(" | "));
  check("two suffixes are both dropped",
    canonicalRetailer("Foo Pty Limited") === canonicalRetailer("Foo"),
    `${canonicalRetailer("Foo Pty Limited")} vs ${canonicalRetailer("Foo")}`);
  check("case and spacing do not",
    canonicalRetailer("  Red   Energy  ") === canonicalRetailer("RED ENERGY"));
  check("an ampersand matches the word",
    canonicalRetailer("Simply Energy & Co") === canonicalRetailer("Simply Energy and Co"));
  check("a footnote marker does not make a second retailer",
    canonicalRetailer("Alinta Energy*") === canonicalRetailer("Alinta Energy"),
    canonicalRetailer("Alinta Energy*"));
  check("nor a numbered footnote",
    canonicalRetailer("Momentum Energy (1)") === canonicalRetailer("Momentum Energy"));

  // The restraint, and why. A merge is invisible where a split is a gap, so
  // brand words are never stripped — guessing here would silently add two
  // companies' customers together.
  check("brand words are NOT stripped: Origin stays distinct from Origin Energy",
    canonicalRetailer("Origin") !== canonicalRetailer("Origin Energy"));
  check("so EnergyAustralia does not collapse to 'australia'",
    canonicalRetailer("EnergyAustralia").includes("energyaustralia"),
    canonicalRetailer("EnergyAustralia"));
  check("and Momentum Energy keeps its brand",
    canonicalRetailer("Momentum Energy") === "momentum_energy",
    canonicalRetailer("Momentum Energy"));
}

console.log("Jurisdictions and fuels onto a closed vocabulary:");
{
  check("a spelled-out state matches its code",
    canonicalJurisdiction("New South Wales") === "NSW" && canonicalJurisdiction("nsw") === "NSW");
  check("punctuation does not hide it", canonicalJurisdiction("N.S.W.") === "NSW",
    String(canonicalJurisdiction("N.S.W.")));
  check("every code round-trips", JURISDICTIONS.every((j) => canonicalJurisdiction(j) === j));
  // Null, not the raw string: an unrecognised value in the canonical column
  // would masquerade as one a query could filter on.
  check("an unrecognised jurisdiction is null, not passed through",
    canonicalJurisdiction("Region 4") === null);
  check("and null stays null", canonicalJurisdiction(null) === null);

  check("fuels normalise", canonicalFuel("Electricity") === "electricity" &&
    canonicalFuel("ELEC") === "electricity" && canonicalFuel("Gas") === "gas");
  check("dual fuel is its own value", canonicalFuel("Dual Fuel") === "dual");
  check("every fuel round-trips", FUELS.every((f) => canonicalFuel(f) === f));
  check("an unrecognised fuel is null", canonicalFuel("hydrogen blend") === null);
}

console.log("Customer segment, the dimension the schema lacked:");
{
  check("the three segments normalise",
    canonicalCustomerType("Residential") === "residential" &&
      canonicalCustomerType("Small Business") === "small_business" &&
      canonicalCustomerType("Large") === "large");
  check("the sheet-name abbreviations do too",
    canonicalCustomerType("SmLBiz") === "small_business" &&
      canonicalCustomerType("Lrg") === "large" && canonicalCustomerType("Res") === "residential",
    [canonicalCustomerType("SmLBiz"), canonicalCustomerType("Lrg")].join("/"));
  check("every segment round-trips", CUSTOMER_TYPES.every((c) => canonicalCustomerType(c) === c));
  check("an unrecognised segment is null", canonicalCustomerType("Government") === null);
  // Without this dimension the Residential, Small Business and Large sheets of
  // one workbook share a key and silently overwrite each other.
  check("the three are distinct keys",
    new Set(["Residential", "Small Business", "Large"].map(canonicalCustomerType)).size === 3);
  check("it travels with the other dimensions",
    canonicalDimensions("AGL", null, "Electricity", "Residential").customerType === "residential");
  check("and keeps its raw string",
    canonicalDimensions("AGL", null, "Electricity", "Small Business").customerTypeRaw === "Small Business");
}

console.log("Refusing a total:");
{
  for (const label of ["Total", "TOTAL", "All retailers", "Grand total", "Subtotal",
                       "Total - electricity", "All jurisdictions", "NEM", "National", ""]) {
    check(`"${label || "(blank)"}" is an aggregate`, isAggregateLabel(label));
  }
  check("a real retailer is not", !isAggregateLabel("AGL Energy"));
  check("nor one whose name contains 'total'", !isAggregateLabel("Totally Energy Pty Ltd"),
    String(isAggregateLabel("Totally Energy Pty Ltd")));

  // The row must not reach the table at all. Summed with the parts it totals,
  // every figure the tool reports comes back roughly double.
  check("an aggregate row is marked skip",
    canonicalDimensions("Total", "NSW", "Electricity").skip === true);
  check("a real row is not",
    canonicalDimensions("AGL Energy Ltd", "NSW", "Electricity").skip === false);
  check("an aggregate jurisdiction on a real retailer is null, not a skip",
    canonicalDimensions("AGL Energy", "Total", "Gas").skip === false &&
      canonicalDimensions("AGL Energy", "Total", "Gas").jurisdiction === null);
}

console.log("Canonical and raw travel together:");
{
  const d = canonicalDimensions("AGL Energy Ltd", "New South Wales", "Elec");
  check("canonical is the key", d.retailer === "agl_energy" && d.jurisdiction === "NSW" &&
    d.fuel === "electricity", JSON.stringify(d));
  // Kept forever, because it is the only thing a wrong canonicalisation can be
  // recomputed from — there is no re-deriving it from the canonical key.
  check("raw is preserved exactly", d.retailerRaw === "AGL Energy Ltd" &&
    d.jurisdictionRaw === "New South Wales" && d.fuelRaw === "Elec");
  check("an unmapped jurisdiction still keeps its raw string",
    canonicalDimensions("AGL", "Region 4", null).jurisdictionRaw === "Region 4");
}

console.log("A definition that changed under an unchanged name:");
{
  const A = "The number of residential customers disconnected for non-payment.";
  const B = "The number of residential customers disconnected for non-payment, excluding those reconnected within 7 days.";

  // Reflow and punctuation are not a change. They happen every quarter, and
  // counting them would bury the one that matters.
  check("whitespace and case are not a change",
    definitionKey(A) === definitionKey("  the number of residential customers\n  disconnected for non-payment  "),
    `${definitionKey(A)} vs ${definitionKey("  the number of residential customers\n  disconnected for non-payment  ")}`);
  check("a trailing full stop is not a change",
    definitionKey(A) === definitionKey(A.replace(/\.$/, "")));
  check("curly and straight quotes are not a change",
    definitionKey('a "disconnection" means x') === definitionKey('a “disconnection” means x'));
  // The one that is.
  check("an added exclusion IS a change", definitionKey(A) !== definitionKey(B));

  const existing = [{ metric: "disconnections", definitionKey: definitionKey(A) }];
  const same = classifyDefinitions([{ metric: "disconnections", definition: A, sheetName: "Notes", cellRef: null }], existing);
  check("the same definition again is 'restated'", same[0].status === "restated", JSON.stringify(same));

  const moved = classifyDefinitions([{ metric: "disconnections", definition: B, sheetName: "Notes", cellRef: null }], existing);
  check("a moved definition is 'changed'", moved[0].status === "changed", JSON.stringify(moved));
  check("and names what it supersedes, so the pair is comparable",
    moved[0].previousKeys?.includes(definitionKey(A)) === true);

  const fresh = classifyDefinitions([{ metric: "hardship_customers", definition: A, sheetName: "Notes", cellRef: null }], existing);
  check("a metric with no recorded definition is 'new', not 'changed'",
    fresh[0].status === "new", JSON.stringify(fresh));

  // One workbook states the same definition on several sheets.
  const twice = classifyDefinitions([
    { metric: "disconnections", definition: A, sheetName: "Notes", cellRef: null },
    { metric: "disconnections", definition: A, sheetName: "Sheet2", cellRef: null },
  ], []);
  check("the same definition twice in one workbook is one outcome", twice.length === 1,
    JSON.stringify(twice));

  // An empty or stub definition is what a model returns for a sheet that
  // states none; storing those would look like coverage while saying nothing.
  check("an empty definition is refused", definitionProblem("") !== null);
  check("a stub is refused", definitionProblem("customers") !== null);
  check("a real one is accepted", definitionProblem(A) === null);
  check("refused definitions produce no outcome",
    classifyDefinitions([{ metric: "x", definition: "", sheetName: "s", cellRef: null }], []).length === 0);
}

console.log("A filter has to be canonicalised the same way the column was:");
{
  // The bug that moving the dimensions to canonical keys introduced. The
  // stored column holds `agl_energy`; a filter of "AGL Energy" compared
  // against it matches nothing, and "no rows matched" reads exactly like
  // "that retailer reported nothing". Both sides go through one function or
  // the query is silently empty.
  check("a natural retailer name lands on the stored key",
    canonicalRetailer("AGL Energy") === canonicalRetailer("AGL Energy Ltd"));
  check("a spelled-out state lands on the stored code",
    canonicalJurisdiction("New South Wales") === canonicalJurisdiction("NSW"));
  check("an abbreviated fuel lands on the stored value",
    canonicalFuel("Elec") === canonicalFuel("electricity"));

  // An unrecognised value must narrow to nothing, not widen to everything:
  // canonicalJurisdiction returns null for it, and a null filter means "no
  // filter". The store keeps the raw string in that case so the query matches
  // no row — a filter nobody can satisfy, rather than a filter ignored.
  check("an unrecognised jurisdiction canonicalises to null",
    canonicalJurisdiction("Region 4") === null,
    "the store must fall back to the raw string, not drop the filter");
}

console.log(failures === 0 ? "\nAll AER consistency checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
