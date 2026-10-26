/**
 * Does the query select every column the mapper reads?
 *
 *   pnpm verify:aer-projection
 *
 * `queryAer` writes a SELECT list by hand and `toObservation` maps the result
 * row onto `AerObservationRow`. Nothing connects the two, and when they
 * disagree the mapper's `??` fallbacks make the disagreement *plausible*
 * instead of loud.
 *
 * That is not hypothetical. The first real ingest reported
 * `retailerRaw: "agl"` — the canonical key wearing the verbatim column's name
 * — because the SELECT omitted `retailer_raw` and the mapper fell back to
 * `row.retailer`. Five more columns were missing the same way, so
 * `customerType`, every `*Raw` dimension and `releaseLabel` read as null or as
 * a substitute for every row ever returned. The facets query, which does
 * select `retailer_raw`, reported "AGL" correctly at the same time — so the
 * two halves of one response disagreed and neither looked broken.
 *
 * A fallback that substitutes a *different real value* cannot be caught by
 * reading the output, which is why this is checked statically instead: parse
 * the SELECT list, parse the `row.<column>` reads out of the mapper, and
 * require the first to cover the second.
 *
 * Offline, no database: it reads the source.
 */
import fs from "node:fs";
import path from "node:path";

let failed = false;
const fail = (message, detail) => {
  failed = true;
  console.log(`FAIL  ${message}${detail ? `\n      ${detail}` : ""}`);
};
const pass = (message) => console.log(`ok    ${message}`);

const source = fs.readFileSync(
  path.join(process.cwd(), "lib/aerPerformanceStore.ts"),
  "utf8"
);

// --- what the mapper reads -------------------------------------------------
const mapperStart = source.indexOf("function toObservation(");
if (mapperStart === -1) {
  fail("could not find toObservation — has it been renamed?");
  process.exit(1);
}
const mapperEnd = source.indexOf("\n}\n", mapperStart);
const mapper = source.slice(mapperStart, mapperEnd);

const read = new Set();
for (const m of mapper.matchAll(/\browe?\.([a-z_][a-z0-9_]*)/gi)) read.add(m[1]);
// `row.` only; the alias above also catches `rows.` style typos, so drop any
// key that is obviously not a column.
read.delete("length");

if (read.size === 0) {
  fail("found no row.<column> reads in toObservation — the parse is wrong, not the code");
} else {
  pass(`toObservation reads ${read.size} columns`);
}

// --- what the row query selects --------------------------------------------
// The observation SELECT is the one that also computes the window functions,
// which distinguishes it from the facet queries in the same file.
const selectStart = source.indexOf("SELECT schedule, period_label");
if (selectStart === -1) {
  fail("could not find the observation SELECT — has the query been rewritten?");
  process.exit(1);
}
const selectEnd = source.indexOf("FROM aer_performance", selectStart);
const selectList = source.slice(selectStart, selectEnd);

const selected = new Set();
for (const m of selectList.matchAll(/\b([a-z_][a-z0-9_]*)\b(?!\s*\()/g)) selected.add(m[1]);
// Aliases introduced by the window functions are columns of the result too.
for (const m of selectList.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)) selected.add(m[1]);

const SQL_WORDS = new Set(["select", "as", "over", "from", "filter", "where", "distinct", "and", "or", "not", "null", "is"]);
for (const word of SQL_WORDS) selected.delete(word);

if (selected.size === 0) {
  fail("parsed no columns out of the SELECT list — the parse is wrong, not the code");
} else {
  pass(`the observation SELECT projects ${selected.size} names`);
}

// --- the check that matters ------------------------------------------------
const missing = [...read].filter((column) => !selected.has(column));
if (missing.length === 0) {
  pass("every column the mapper reads is selected");
} else {
  fail(
    `${missing.length} column(s) the mapper reads are NOT selected: ${missing.join(", ")}`,
    "Each one silently becomes null, or whatever the mapper's ?? fallback names — which is " +
      "how retailerRaw came back as the canonical key for every row."
  );
}

// The six that were actually missing. Named individually so a regression says
// which one, and so this check still means something if the parse above ever
// goes slack and starts matching everything.
console.log("\nThe six that were missing, by name:");
for (const column of [
  "retailer_raw",
  "jurisdiction_raw",
  "fuel_raw",
  "customer_type",
  "customer_type_raw",
  "release_label",
]) {
  if (selected.has(column)) pass(`${column} is selected`);
  else fail(`${column} is not selected`);
}

// A fallback is only safe where it cannot be mistaken for data. `releaseLabel`
// falling back to the period is a documented equivalence; `retailerRaw`
// falling back to the canonical key is not, so the column has to be there.
console.log("\nAnd the fallback that made it invisible:");
if (/retailerRaw:\s*row\.retailer_raw/.test(mapper)) {
  pass("retailerRaw is mapped from retailer_raw");
} else {
  fail("retailerRaw is no longer mapped from retailer_raw", mapper.match(/retailerRaw:[^\n]*/)?.[0]);
}

// ---------------------------------------------------------------------------
// No camelCase SQL aliases anywhere in the store
// ---------------------------------------------------------------------------
// Postgres folds an unquoted identifier to lower case, so `AS customerTypes`
// yields a result key of `customertypes`. A mapper reading `row.customerTypes`
// then gets `undefined`, and a `?? []` turns that into an empty list rather
// than an error — so the customerTypes facet reported "nothing recorded" for
// every query ever made, while the rows in the same response carried
// "residential" and "small_business".
//
// This is the same shape as the projection bug above: a query and its mapper
// disagreeing, with a fallback making the disagreement look like data. Checked
// the same way, across every query in the file rather than the one that broke.
console.log("\nSQL aliases Postgres will not give back as written:");
{
  const aliases = [...source.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const camel = aliases.filter((a) => /[a-z]/.test(a) && /[A-Z]/.test(a));
  if (aliases.length === 0) {
    fail("found no SQL aliases at all — the parse is wrong, not the code");
  } else if (camel.length === 0) {
    pass(`all ${aliases.length} alias(es) survive Postgres case folding`);
  } else {
    fail(
      `${camel.length} camelCase alias(es): ${[...new Set(camel)].join(", ")}`,
      "Postgres lower-cases these, so the mapper reads undefined and any ?? fallback hides it. " +
        "Use snake_case, as every other alias in this file does."
    );
  }
}

console.log(
  failed ? "\nSome AER projection checks FAILED." : "\nAll AER projection checks passed."
);
process.exit(failed ? 1 : 0);
