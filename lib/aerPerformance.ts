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
