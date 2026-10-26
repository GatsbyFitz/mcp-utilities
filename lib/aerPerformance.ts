// ---------------------------------------------------------------------------
// AER retail performance data — the vocabulary
// ---------------------------------------------------------------------------
// The app can say what the rules require (search_docs), who was penalised for
// breaking them (search_compliance) and how a process runs (display_process).
// It could not say anything quantitative about the market itself. The AER
// publishes exactly that, quarterly, as Schedules 2, 3 and 4.
//
// Pure, and importing nothing from lib/db, so these types and helpers can be
// used from a step, a tool or a test without constructing a database client at
// module load. The same split as lib/compliance.ts vs lib/complianceStore.ts.

/** The schedules the AER publishes, as it numbers them. */
export const SCHEDULES = [2, 3, 4] as const;
export type Schedule = (typeof SCHEDULES)[number];

/** What each one covers, for tool descriptions and for the inference prompt. */
export const SCHEDULE_SUBJECTS: Record<Schedule, string> = {
  2: "customer numbers, switching, contracts, meter installations and tariffs",
  3: "complaints, debt, Centrepay, payment plans, concessions and disconnections",
  4: "hardship customer numbers and hardship debt",
};

export interface AerObservationRow {
  schedule: Schedule;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  /** Canonical key, stable across quarters. What a query filters on. */
  retailer: string;
  /** Exactly as the workbook wrote it. Kept so a wrong fold is recomputable. */
  retailerRaw: string;
  jurisdiction: string | null;
  jurisdictionRaw: string | null;
  fuel: string | null;
  fuelRaw: string | null;
  /** Residential / small business / large, where the sheet distinguishes. */
  customerType: string | null;
  customerTypeRaw: string | null;
  /**
   * The release this observation was read from, e.g. "2023-24 Q4". Distinct
   * from `periodLabel`: one workbook states five quarters, so the release says
   * *which publication* this number came from and the period says *what it
   * measures*. Needed because a later release restates earlier quarters.
   */
  releaseLabel: string;
  /** Canonical key, stable across quarters. What a query filters on. */
  metric: string;
  /** The header exactly as that workbook wrote it. */
  metricRaw: string;
  value: number;
  sourceFile: string;
  sheetName: string;
  cellRef: string;
}

/** A canonical metric and every header ever seen for it. */
export interface AerMetric {
  schedule: Schedule;
  metric: string;
  aliases: string[];
  firstSeen: string;
}

/**
 * A stable key for a column header.
 *
 * Only a normalisation — it collapses case, punctuation and spacing, so
 * "Residential Customers (no.)" and "residential customers no" land on the
 * same key. It does **not** recognise a rename: "Residential customer numbers"
 * normalises to something different, and matching that to its predecessor is a
 * semantic judgement made during inference, against the vocabulary already
 * known for the schedule. This function is the floor, not the mechanism.
 */
export function canonicalMetric(header: string): string {
  return header
    .toLowerCase()
    // `%` is a unit, not punctuation. Stripped along with the rest of it,
    // "Electricity Residential Contracts Deemed" and "… Contracts % Deemed"
    // became one key — so two columns of one sheet wrote the same observation
    // key, `aer_performance_observation_idx` kept the later, and a share
    // overwrote a count: a ratio sitting where a customer count belonged, in
    // different units from the series it replaced, with no gap to see.
    // Spelled out instead, so the two keys differ and both columns survive.
    // Only headers carrying a `%` change key; every other key is unaffected.
    .replace(/%/g, " pct ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

/**
 * The calendar bounds of an AER period label.
 *
 * Australian financial year: Q1 is July–September of the first year, so
 * "2023-24 Q3" is January–March 2024. Getting this wrong would put a quarter
 * of data six months from where it belongs, and nothing downstream would
 * notice — a date range query would simply return the wrong quarter.
 *
 * Returns null rather than guessing: a label that cannot be parsed is a
 * question for a person, not something to approximate.
 */
export function periodBounds(label: string): { start: string; end: string } | null {
  const match = label.trim().match(/^(\d{4})\s*[-–/]\s*(\d{2,4})\s*Q([1-4])$/i);
  if (!match) return null;

  const firstYear = Number(match[1]);
  const quarter = Number(match[3]);

  // Q1 Jul–Sep and Q2 Oct–Dec fall in the first year; Q3 and Q4 in the second.
  const startMonth = [7, 10, 1, 4][quarter - 1];
  const year = quarter <= 2 ? firstYear : firstYear + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();

  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    start: `${year}-${pad(startMonth)}-01`,
    end: `${year}-${pad(endMonth)}-${pad(lastDay)}`,
  };
}

/**
 * A column headed by a bare financial year rather than a quarter.
 *
 * The five-quarter sheets carry a *second* block of columns further right
 * whose period row holds `2019-20`, `2020-21`, … — annual figures, not
 * quarterly ones. That was discovered the expensive way: the first real
 * ingest refused all six of Schedule 2's main sheets, because
 * `mappingProblems` requires every mapped column to carry a readable quarter
 * and these carry a readable *year*.
 *
 * They are recognised so they can be **dropped**, not stored. An annual figure
 * is the sum of the four quarters beside it, so filing one as an observation
 * is the "ACT Total" failure in column form: every total the tool reports
 * comes back inflated, invisibly, carrying the exactness it advertises.
 *
 * Narrow on purpose. Only a bare `YYYY-YY` or `YYYY-YYYY`, optionally wrapped
 * in the words a header uses around one — so a quarter is never mistaken for a
 * year, and a genuinely unreadable period still fails its sheet loudly rather
 * than being quietly discarded as "probably annual".
 */
export function isAnnualPeriodLabel(raw: string): boolean {
  const flat = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!flat) return false;
  // A quarter marker anywhere means this is not an annual column.
  if (/\bq[1-4]\b|\bquarter\b/.test(flat)) return false;
  return /^(fy|financial year|year|total|full year)?\s*\d{4}\s*[-–/]\s*\d{2,4}\s*(total|annual|full year)?$/.test(
    flat
  );
}

/**
 * The canonical form of a period label as a workbook writes it.
 *
 * The sheets put the quarter first — `Q4 2023-24` — while `periodBounds` and
 * everything stored speak `2023-24 Q4`. One function, because the columns of a
 * real workbook *are* periods: getting this backwards would file a quarter
 * under a label that parses but means a different three months, and no later
 * query could detect it.
 *
 * Returns null rather than guessing, so a header that is not a period simply
 * is not treated as one.
 */
export function normalizePeriodLabel(raw: string): string | null {
  const flat = raw.replace(/\s+/g, " ").trim();
  // "Q4 2023-24" / "Q4 2023–24" / "Q4 2023/24"
  const quarterFirst = flat.match(/^Q([1-4])\s+(\d{4})\s*[-–/]\s*(\d{2,4})$/i);
  if (quarterFirst) {
    const second = quarterFirst[3].length === 4 ? quarterFirst[3].slice(2) : quarterFirst[3].padStart(2, "0");
    const label = `${quarterFirst[2]}-${second} Q${quarterFirst[1]}`;
    return periodBounds(label) ? label : null;
  }
  // Already canonical, or close enough for periodBounds to read.
  const yearFirst = flat.match(/^(\d{4})\s*[-–/]\s*(\d{2,4})\s*Q([1-4])$/i);
  if (yearFirst) {
    const second = yearFirst[2].length === 4 ? yearFirst[2].slice(2) : yearFirst[2].padStart(2, "0");
    const label = `${yearFirst[1]}-${second} Q${yearFirst[3]}`;
    return periodBounds(label) ? label : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Counting what was actually stored
// ---------------------------------------------------------------------------
// `replaceScheduleRows` inserts `ON CONFLICT DO UPDATE`, so two rows that
// share an observation key resolve themselves: the later overwrites the
// earlier, one statement affects one row, and nothing raises. It then
// reported `rows.length` as the number written, which is the number
// *attempted* — a count that cannot be wrong in the direction that matters,
// because it never looks.
//
// That is how 11,910 observations went missing from a Schedule 2 ingest
// without a single error: the step said 57,786 written and the table held
// 45,876. The gap was only visible by reading those two numbers side by side
// and noticing, which is not a mechanism.
//
// `mappingProblems` now refuses two columns of one sheet that claim the same
// metric, so the known cause is caught before anything is written. This is
// the backstop for the unknown ones — above all a collision *between* sheets,
// which no single sheet's mapping can see.

/**
 * The key `aer_performance_observation_idx` enforces, rebuilt here so a
 * collision can be counted before Postgres quietly resolves it.
 *
 * Must mirror the index exactly, including `COALESCE(…, '')` on the three
 * nullable dimensions — a key that differs from the index's would report
 * collisions that will not happen, or miss ones that will.
 */
export function observationKey(row: {
  schedule: number;
  periodLabel: string;
  retailer: string;
  metric: string;
  jurisdiction?: string | null;
  fuel?: string | null;
  customerType?: string | null;
}): string {
  return [
    row.schedule,
    row.periodLabel,
    row.retailer,
    row.metric,
    row.jurisdiction ?? "",
    row.fuel ?? "",
    row.customerType ?? "",
  ].join("\u0000");
}

export interface ObservationCollisions {
  /** Rows that will exist afterwards. The honest "written". */
  distinct: number;
  /** Rows that will overwrite another. Should be zero. */
  overwritten: number;
  /** A few of them, named well enough to find the columns responsible. */
  examples: string[];
}

export function observationCollisions(
  rows: {
    schedule: number;
    periodLabel: string;
    retailer: string;
    metric: string;
    jurisdiction?: string | null;
    fuel?: string | null;
    customerType?: string | null;
    sheetName?: string;
    cellRef?: string;
  }[]
): ObservationCollisions {
  const firstSeen = new Map<string, string>();
  const examples: string[] = [];
  let overwritten = 0;

  for (const row of rows) {
    const key = observationKey(row);
    const where = `${row.sheetName ?? "?"}!${row.cellRef ?? "?"}`;
    const prior = firstSeen.get(key);
    if (prior === undefined) {
      firstSeen.set(key, where);
      continue;
    }
    overwritten++;
    // Capped, because a wrong mapping produces thousands of these and the
    // first few are enough to find the columns. The count is the measurement;
    // the examples are the lead.
    if (examples.length < MAX_COLLISION_EXAMPLES) {
      examples.push(
        `${row.retailer}/${row.metric}/${row.jurisdiction ?? "-"}/${row.periodLabel}: ` +
          `${where} overwrites ${prior}`
      );
    }
  }

  return { distinct: firstSeen.size, overwritten, examples };
}

const MAX_COLLISION_EXAMPLES = 5;

// ---------------------------------------------------------------------------
// Totals that do not double-count
// ---------------------------------------------------------------------------
// `NATIONAL` is a jurisdiction the AER reports against, not a sum of the
// others — see the comment on `JURISDICTIONS` in lib/aerDimensions.ts. The
// consequence lands here: a match set holding both the national figure and the
// per-jurisdiction figures sums to roughly double, because the national row
// covers customers the jurisdiction rows do not (Victorian retail reports to
// the Essential Services Commission, so there is no VIC block to add).
//
// That is the worst shape of error available to this tool. A split series
// reads low and shows up as a gap; this reads high and shows up as nothing at
// all, carrying the exactness the tool advertises in its own description.
//
// So there is no single total in that case. Both halves are reported instead,
// which loses no information and makes the reason visible, rather than a
// number that is quietly wrong or a number quietly withheld.
//
// Pure, and separate from the query that counts the rows, so the decision is
// checkable by `pnpm verify:aer` with no database.

export interface ScopeTotals {
  /** The one meaningful total, or null when there is not one. */
  totalValue: number | null;
  /** The matched national rows alone. Null when none matched. */
  nationalValue: number | null;
  /** The matched per-jurisdiction rows alone. Null when none matched. */
  subNationalValue: number | null;
  /** True when both halves matched, which is when `totalValue` is null. */
  scopesMixed: boolean;
}

export function scopeTotals(counts: {
  totalCount: number;
  nationalCount: number;
  totalValue: number | null;
  nationalValue: number | null;
  subNationalValue: number | null;
}): ScopeTotals {
  const { totalCount, nationalCount } = counts;
  const hasNational = nationalCount > 0;
  const hasSubNational = nationalCount < totalCount;
  const scopesMixed = hasNational && hasSubNational;
  return {
    // Zero rather than null on an empty match set: no rows is a total of
    // nothing, which is a different statement from "a total would mislead".
    totalValue: scopesMixed ? null : counts.totalValue ?? 0,
    nationalValue: hasNational ? counts.nationalValue ?? 0 : null,
    subNationalValue: hasSubNational ? counts.subNationalValue ?? 0 : null,
    scopesMixed,
  };
}

/** Observations stored per ingest. A guard, not a real limit. */
export const MAX_OBSERVATIONS_PER_INGEST = 200_000;
/** Rows a query returns. Counts and totals are computed over the full set. */
export const MAX_AER_ROWS = 500;

// ---------------------------------------------------------------------------
// The "not provisioned yet" case
// ---------------------------------------------------------------------------

/** The Postgres error raised when the table has never been created. */
export function isMissingAerTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /relation .*(aer_performance|aer_metrics).* does not exist/i.test(message);
}

/** Names the file to run. Keep it a path someone can act on directly. */
export const MISSING_AER_MESSAGE =
  "The aer_performance tables do not exist yet — run db/aer_performance.sql against the database.";
