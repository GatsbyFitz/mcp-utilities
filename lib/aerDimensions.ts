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

/**
 * Jurisdictions the AER reports against, as it abbreviates them — plus
 * `NATIONAL`, which is one of them and not a sum of them.
 *
 * `NATIONAL` is here reluctantly, because an aggregate stored as an
 * observation is the failure this file spends most of its length warning
 * about — and measured against a real workbook it *is* an aggregate wherever
 * the metric adds up. AGL's national residential electricity count in
 * 2022-23 Q4 is 1,518,827, and its ACT, NSW, QLD and SA blocks come to
 * 1,518,827 exactly. Nothing is left over because Victoria is absent from the
 * whole schedule — Victorian retail reports to the Essential Services
 * Commission — so "National" here means the AER's own jurisdictions.
 *
 * (An earlier version of this comment claimed the opposite, that the blocks
 * came nowhere near the national figure and so carried customers found in no
 * other row. That was never measured and it is wrong. The conclusion below
 * survives it, which is why the correction is recorded rather than quietly
 * swapped: the reasons are different and only one of them is a fact.)
 *
 * Two things earn the exception anyway:
 *
 *  - **It is not an aggregate for a ratio.** AGL's national residential
 *    electricity market share is 0.2189 while its four jurisdiction shares sum
 *    to 1.008. A ratio cannot be recovered from the parts without the weights
 *    they were taken over, so refusing the national row would destroy every
 *    national percentage series outright and leave no way to rebuild it.
 *  - **Some sheets carry a national block and nothing else** — `Lrg Gas
 *    Cust#s & Mkt Contr` among them. There it is the only row there is.
 *
 * So the cost is exact rather than hypothetical: a sum over a match set
 * holding both scopes returns *precisely* double. `scopeTotals` in
 * lib/aerPerformance.ts is where that is paid, once, rather than left to each
 * caller to remember — the mistake `isAggregateLabel`'s own comment warns
 * against. The alternative, a null jurisdiction, is what collapsed eight
 * tables into one and stored that South Australian 306,896 as the national
 * figure.
 */
export const JURISDICTIONS = [
  "NATIONAL",
  "NSW",
  "VIC",
  "QLD",
  "SA",
  "TAS",
  "ACT",
  "NT",
  "WA",
] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

/**
 * The one jurisdiction that is an aggregate over the others, named so a query
 * can exclude it without matching on a string literal.
 */
export const NATIONAL: Jurisdiction = "NATIONAL";

const JURISDICTION_NAMES: Record<string, Jurisdiction> = {
  national: "NATIONAL",
  australia: "NATIONAL",
  "all jurisdictions": "NATIONAL",
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


/**
 * What a label in column A, on a row with no values beside it, actually is.
 *
 * Every AER data sheet is several tables stacked vertically, and the only
 * thing marking the boundaries is a row like this. `Res Elec Cust#s & Mkt
 * Contr` holds fourteen of them: a note, a "Jurisdictions" divider, five
 * jurisdictions, a "Tier 1 Retailers" divider, and then National plus the same
 * five again for a subset of retailers.
 *
 * Classifying them is what keeps those tables apart. Reading the sheet as one
 * flat table — which is what it looked like through a fixture that stopped at
 * row 30 — put every block on one observation key and left the last one
 * written standing for all of them.
 *
 * The four kinds are distinguished because each needs different handling, and
 * conflating any two of them loses something:
 *
 *  - `jurisdiction` — rows below it belong to that jurisdiction.
 *  - `divider` — structural only ("Jurisdictions"), carrying no attribution.
 *    It must *not* clear the current jurisdiction, because the next header
 *    sets one immediately.
 *  - `scope` — "Tier 1 Retailers" and the like. It re-scopes the whole rest of
 *    the sheet to a subset of retailers, which is a dimension this schema does
 *    not have, so everything after it is dropped rather than merged into the
 *    full-population figures it would collide with.
 *  - `unknown` — anything else. Dropped, loudly. Letting unrecognised rows
 *    inherit the previous block's jurisdiction is the wrongly-merged failure,
 *    and a gap in the data is visible where a wrong attribution is not.
 */
export type BlockLabelKind = "jurisdiction" | "divider" | "scope" | "unknown";

/** Section dividers that carry no attribution of their own. */
const BLOCK_DIVIDERS = new Set([
  "jurisdictions",
  "jurisdiction",
  "by jurisdiction",
  "states",
  "state",
  "retailers",
  "retailer",
]);

export function blockLabelKind(raw: string): {
  kind: BlockLabelKind;
  jurisdiction: Jurisdiction | null;
} {
  const flat = flatten(raw)
    .replace(/[.]/g, "")
    .replace(/[\s]*[*†‡]+$/, "")
    .trim();
  if (!flat) return { kind: "unknown", jurisdiction: null };

  const jurisdiction = canonicalJurisdiction(flat);
  if (jurisdiction) return { kind: "jurisdiction", jurisdiction };

  if (BLOCK_DIVIDERS.has(flat)) return { kind: "divider", jurisdiction: null };

  // "Tier 1 Retailers", "Tier 2", "Second tier retailers" — a retailer-set
  // scope. Matched on the word rather than the exact phrase because the
  // wording varies between schedules and a missed one would silently merge a
  // subset's figures into the whole population's.
  if (/\btier\s*\d?\b/.test(flat)) return { kind: "scope", jurisdiction: null };

  return { kind: "unknown", jurisdiction: null };
}

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
  //
  // The leading word must be followed by *nothing*, by punctuation, or by a
  // dimension word — not by just any word. Unqualified, this matched
  // "Total Energies", a live energy brand, and refused it as an aggregate.
  // Narrowing it is not a softening: a label beginning "Total" and continuing
  // into a company name was never a subtotal.
  if (
    /^(grand\s+)?(total|subtotal|sub-total)\b(\s*$|\s*[-–—,:;(/]|\s+(all|electricity|elec|gas|dual|residential|small|large|business|retailers?|jurisdictions?|states?|fuels?|customers?|national|nem)\b)/.test(
      flat
    )
  ) {
    return true;
  }
  if (/^all\s+(retailers?|jurisdictions?|states?|fuels?)\b/.test(flat)) return true;
  // "ACT Total", "NSW Total", "National Total" — the word at the *end*.
  //
  // This is how the AER actually writes a jurisdiction subtotal, and the
  // leading-anchor patterns above all missed it: the first real ingest stored
  // "ACT Total" as a retailer with 198,786 residential contracts, to be summed
  // alongside the ACT retailers composing it. Exactly the double that reads
  // high and shows up as nothing.
  //
  // Trailing-only, deliberately. A leading match would also catch a real
  // company — "Total Energies" is a live brand — and refusing a genuine
  // retailer is the cheaper mistake only because it is *visible*: a refused
  // row leaves a gap, a stored total silently inflates every figure the tool
  // reports. Where that trade has to be made, make it toward refusing.
  if (/\b(sub)?totals?$/.test(flat)) return true;
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
  if (!flat) return null;
  // Looked up before the aggregate guard, not after. "National" and
  // "Australia" are both in AGGREGATE_LABELS — correctly, for a *retailer*
  // cell — so checking that first returned null for the one jurisdiction the
  // AER reports most of its data against, and a null jurisdiction is what let
  // every block share a key.
  const named = JURISDICTION_NAMES[flat];
  if (named) return named;
  if (isAggregateLabel(flat)) return null;
  return null;
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

/**
 * Customer segment. A dimension the schema did not have, and the first real
 * workbook has three of them on separate sheets: Residential, Small Business
 * and Large. Without it, those three sheets share
 * `(schedule, period, retailer, metric, jurisdiction, fuel)` and silently
 * overwrite each other — three segments collapsing to whichever wrote last.
 */
export const CUSTOMER_TYPES = ["residential", "small_business", "large"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

const CUSTOMER_TYPE_NAMES: Record<string, CustomerType> = {
  residential: "residential",
  res: "residential",
  domestic: "residential",
  "small business": "small_business",
  smallbusiness: "small_business",
  small_business: "small_business",
  smlbiz: "small_business",
  smallbiz: "small_business",
  sme: "small_business",
  business: "small_business",
  large: "large",
  lrg: "large",
  "large business": "large",
  industrial: "large",
};

export function canonicalCustomerType(raw: string | null): CustomerType | null {
  if (!raw) return null;
  const flat = flatten(raw).replace(/[\s]*[*†‡]+$/, "").replace(/\s+/g, " ").trim();
  if (!flat || isAggregateLabel(flat)) return null;
  return CUSTOMER_TYPE_NAMES[flat] ?? CUSTOMER_TYPE_NAMES[flat.replace(/\s+/g, "")] ?? null;
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
  customerType: CustomerType | null;
  customerTypeRaw: string | null;
  skip: boolean;
}

export function canonicalDimensions(
  retailerRaw: string,
  jurisdictionRaw: string | null,
  fuelRaw: string | null,
  customerTypeRaw: string | null = null
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
    customerType: canonicalCustomerType(customerTypeRaw),
    customerTypeRaw: customerTypeRaw?.trim() ?? null,
    skip,
  };
}
