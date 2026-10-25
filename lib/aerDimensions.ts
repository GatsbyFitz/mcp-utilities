// ---------------------------------------------------------------------------
// AER dimensions: making a series one series
// ---------------------------------------------------------------------------
// `metric` vs `metric_raw` exists because a renamed column otherwise becomes
// two metrics, and a query for either returns half the history. The dimensions
// had no such pair: `extractRows` read the retailer, jurisdiction and fuel
// cells and stored them verbatim.
//
// That is the same bug on the other axis, and it bites harder, because the
// observation index keys on the retailer — so "Origin" and "Origin Energy" are
// not merely two series, they are two rows that never collide and never
// dedupe. Seven quarters of one name and five of the other is a retailer whose
// history appears to stop and a second retailer who appears from nowhere.
//
// So the same discipline: a canonical key to filter on, the raw string kept
// forever so a wrong canonicalisation is recomputable without re-parsing.
//
// **What this does not do is guess.** Only transformations that cannot change
// meaning are applied: case, whitespace, punctuation, `&` for `and`, and the
// legal-entity suffix. Brand words are left alone — stripping "Energy" would
// merge "Origin Energy" to "origin" correctly and turn "EnergyAustralia" into
// "australia", and a wrongly merged series is worse than a split one because
// a split is visible as a gap while a merge is invisible. Genuine brand
// equivalence is a judgement for a person, recorded as an alias, not inferred
// here.
//
// Pure, importing nothing from lib/db, like the rest of the vocabulary.

/** Jurisdictions the AER reports against, as it abbreviates them. */
export const JURISDICTIONS = ["NSW", "VIC", "QLD", "SA", "TAS", "ACT", "NT", "WA"] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

const JURISDICTION_NAMES: Record<string, Jurisdiction> = {
  nsw: "NSW",
  "new south wales": "NSW",
  vic: "VIC",
  victoria: "VIC",
  qld: "QLD",
  queensland: "QLD",
  sa: "SA",
  "south australia": "SA",
  tas: "TAS",
  tasmania: "TAS",
  act: "ACT",
  "australian capital territory": "ACT",
  nt: "NT",
  "northern territory": "NT",
  wa: "WA",
  "western australia": "WA",
};

/** Fuels, as the schedules distinguish them. */
export const FUELS = ["electricity", "gas", "dual"] as const;
export type Fuel = (typeof FUELS)[number];

const FUEL_NAMES: Record<string, Fuel> = {
  electricity: "electricity",
  elec: "electricity",
  electric: "electricity",
  power: "electricity",
  gas: "gas",
  "natural gas": "gas",
  dual: "dual",
  "dual fuel": "dual",
  both: "dual",
  "electricity and gas": "dual",
};

/** Whitespace, case and punctuation collapsed. The floor under everything. */
function flatten(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * A row that is a total rather than an observation.
 *
 * This is the one that would corrupt arithmetic rather than split it.
 * `search_aer_performance` sums the match set with window functions, so a
 * stored "All retailers" or "Total" row is added to the parts it is the total
 * of — every total the tool reports comes back roughly double, with the
 * confident exactness the tool advertises.
 *
 * Storing them and excluding them at query time would be the fragile way
 * round: every future query would have to remember. They are refused at the
 * door instead, and the tool computes its own totals, which is what it already
 * does.
 */
const AGGREGATE_LABELS = new Set([
  "total",
  "totals",
  "total:",
  "all",
  "all retailers",
  "all retailer",
  "all jurisdictions",
  "all states",
  "all fuels",
  "sum",
  "subtotal",
  "sub-total",
  "grand total",
  "national",
  "nem",
  "nem total",
  "nem wide",
  "nem-wide",
  "australia",
  "total (all retailers)",
  "market total",
  "industry total",
  "n/a",
  "na",
  "-",
  "—",
]);

export function isAggregateLabel(raw: string): boolean {
  const flat = flatten(raw).replace(/[*†‡]+$/, "").trim();
  if (!flat) return true;
  if (AGGREGATE_LABELS.has(flat)) return true;
  // "Total - electricity", "Total electricity", "Total, all retailers".
  if (/^(grand\s+)?(total|subtotal|sub-total)\b/.test(flat)) return true;
  if (/^all\s+(retailers?|jurisdictions?|states?|fuels?)\b/.test(flat)) return true;
  return false;
}

/**
 * Legal-entity suffixes, which identify the same company either way.
 *
 * Safe to drop because no two AER retailers differ only by whether the
 * workbook spelled out "Pty Ltd" that quarter. Applied repeatedly, since
 * "Foo Pty Limited" carries two of them.
 */
const LEGAL_SUFFIX =
  /[\s,.]*\b(pty\.?|proprietary|ltd\.?|limited|p\/l|inc\.?|llc|plc|holdings?|group)\b\.?$/;

/**
 * The canonical key for a retailer name.
 *
 * Normalisation only, and deliberately shallow. It collapses the ways one name
 * is *written* — "AGL Energy Ltd", "AGL Energy Limited", "agl energy" — and
 * not the ways two names relate. "Origin" and "Origin Energy" come out
 * different on purpose: they are probably the same company, and "probably" is
 * not a basis for merging a regulatory series. `aer_retailers` records that
 * judgement once a person makes it.
 */
export function canonicalRetailer(raw: string): string {
  let flat = flatten(raw)
    .replace(/&/g, " and ")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Trailing footnote markers the AER sprinkles on retailer names.
  flat = flat.replace(/[\s]*[*†‡]+$/, "").replace(/\s*\(\d+\)$/, "").trim();

  let previous = "";
  while (previous !== flat) {
    previous = flat;
    flat = flat.replace(LEGAL_SUFFIX, "").trim();
  }

  return flat.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

/**
 * The canonical jurisdiction, or null when the cell does not name one.
 *
 * Null rather than the raw string: an unrecognised jurisdiction is a value no
 * query will ever filter on correctly, and keeping it in the canonical column
 * would let it masquerade as one that works. The raw string is stored
 * alongside regardless, so nothing is lost and a missing mapping is visible.
 */
export function canonicalJurisdiction(raw: string | null): Jurisdiction | null {
  if (!raw) return null;
  const flat = flatten(raw)
    .replace(/[.]/g, "")
    .replace(/[\s]*[*†‡]+$/, "")
    .trim();
  if (!flat || isAggregateLabel(flat)) return null;
  return JURISDICTION_NAMES[flat] ?? null;
}

/** The canonical fuel, or null when the cell does not name one. */
export function canonicalFuel(raw: string | null): Fuel | null {
  if (!raw) return null;
  const flat = flatten(raw)
    .replace(/[\s]*[*†‡]+$/, "")
    .trim();
  if (!flat || isAggregateLabel(flat)) return null;
  return FUEL_NAMES[flat] ?? null;
}

/** A retailer name seen in a workbook but not yet mapped to a known brand. */
export interface UnmappedDimension {
  kind: "jurisdiction" | "fuel";
  raw: string;
  /** Where it was seen, so it is traceable. */
  sheetName: string;
}

/**
 * The dimensions of one row, canonical and raw together.
 *
 * `skip` is the aggregate case: the row is a total, and the caller must not
 * store it.
 */
export interface CanonicalDimensions {
  retailer: string;
  retailerRaw: string;
  jurisdiction: Jurisdiction | null;
  jurisdictionRaw: string | null;
  fuel: Fuel | null;
  fuelRaw: string | null;
  skip: boolean;
}

export function canonicalDimensions(
  retailerRaw: string,
  jurisdictionRaw: string | null,
  fuelRaw: string | null
): CanonicalDimensions {
  const retailer = canonicalRetailer(retailerRaw);
  // A total row, or a retailer cell that canonicalises to nothing, is not an
  // observation. Either stored would corrupt a sum rather than a filter.
  const skip = isAggregateLabel(retailerRaw) || retailer.length === 0;
  return {
    retailer,
    retailerRaw: retailerRaw.trim(),
    jurisdiction: canonicalJurisdiction(jurisdictionRaw),
    jurisdictionRaw: jurisdictionRaw?.trim() ?? null,
    fuel: canonicalFuel(fuelRaw),
    fuelRaw: fuelRaw?.trim() ?? null,
    skip,
  };
}
