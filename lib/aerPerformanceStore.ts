import {
  canonicalCustomerType,
  canonicalFuel,
  canonicalJurisdiction,
  canonicalRetailer,
} from "@/lib/aerDimensions";
import {
  MISSING_DEFINITIONS_MESSAGE,
  classifyDefinitions,
  definitionKey,
  definitionProblem,
  isMissingDefinitionsTable,
  type CapturedDefinition,
  type DefinitionOutcome,
} from "@/lib/aerDefinitions";
import { sql } from "@/lib/db";
import {
  MAX_AER_ROWS,
  type AerMetric,
  type AerObservationRow,
  type Schedule,
} from "@/lib/aerPerformance";

// ---------------------------------------------------------------------------
// Reading and writing aer_performance
// ---------------------------------------------------------------------------
// Split from lib/aerPerformance.ts so the vocabulary can be imported without
// `lib/db` constructing a client at module load — the same split as
// lib/compliance.ts vs lib/complianceStore.ts, and the reason the parsing
// checks can run with no database at all.

export interface AerFilters {
  schedule?: number;
  retailer?: string;
  jurisdiction?: string;
  fuel?: string;
  customerType?: string;
  metric?: string;
  /** Inclusive ISO date bounds against the period, not the ingest time. */
  from?: string;
  to?: string;
}

export interface AerResult {
  rows: AerObservationRow[];
  /** Over the whole matching set, not just the returned page. */
  totalCount: number;
  /** Summed over every matching row. Meaningful only within one metric. */
  totalValue: number;
  truncated: boolean;
  latestPeriod: string | null;
}

interface Row {
  schedule: number;
  period_label: string;
  period_start: string | Date;
  period_end: string | Date;
  retailer: string;
  jurisdiction: string | null;
  fuel: string | null;
  metric: string;
  metric_raw: string;
  retailer_raw?: string | null;
  jurisdiction_raw?: string | null;
  fuel_raw?: string | null;
  customer_type?: string | null;
  customer_type_raw?: string | null;
  release_label?: string | null;
  value: string | number;
  source_file: string;
  sheet_name: string;
  cell_ref: string;
  total_count: string | number;
  total_value: string | number | null;
  latest_period: string | null;
}

const iso = (d: string | Date) => new Date(d).toISOString().slice(0, 10);

function toObservation(row: Row): AerObservationRow {
  return {
    schedule: row.schedule as Schedule,
    periodLabel: row.period_label,
    periodStart: iso(row.period_start),
    periodEnd: iso(row.period_end),
    retailer: row.retailer,
    retailerRaw: row.retailer_raw ?? row.retailer,
    jurisdiction: row.jurisdiction ?? null,
    jurisdictionRaw: row.jurisdiction_raw ?? null,
    fuel: row.fuel ?? null,
    fuelRaw: row.fuel_raw ?? null,
    customerType: row.customer_type ?? null,
    customerTypeRaw: row.customer_type_raw ?? null,
    releaseLabel: row.release_label ?? row.period_label,
    metric: row.metric,
    metricRaw: row.metric_raw,
    value: Number(row.value),
    sourceFile: row.source_file,
    sheetName: row.sheet_name,
    cellRef: row.cell_ref,
  };
}

/**
 * Observations matching the filters, newest period first.
 *
 * Every filter is optional inside one statement (`$n IS NULL OR …`) rather
 * than assembled by concatenation — the api-routes rule, and the only way to
 * keep each value a bound parameter.
 *
 * Counts and totals come from window functions over the *unlimited* match set,
 * so they stay exact when the row list is capped. Summing the returned rows
 * would under-report the moment the cap bit, and a quietly low total on
 * regulatory data is the one error this must not make.
 */
export async function queryAer(filters: AerFilters): Promise<AerResult> {
  const {
    schedule = null,
    retailer: retailerFilter = null,
    jurisdiction: jurisdictionFilter = null,
    fuel: fuelFilter = null,
    customerType: customerTypeFilter = null,
    metric = null,
    from = null,
    to = null,
  } = filters;

  // The stored columns hold canonical keys, so the filters have to be put
  // through the same functions or they match nothing. This is the bug that
  // moving the dimensions to canonical keys introduced: `retailer: "AGL
  // Energy"` compared against a stored `agl_energy` returns zero rows, and
  // "no rows matched" reads exactly like "that retailer reported nothing" —
  // the silent-empty failure this file exists to avoid.
  //
  // An unrecognised jurisdiction or fuel canonicalises to null, which would
  // widen the query to everything rather than narrowing it to nothing. That is
  // the wrong way to fail, so the raw filter is kept in that case and simply
  // matches no row — a filter nobody can satisfy, not a filter ignored.
  const retailer = retailerFilter ? canonicalRetailer(retailerFilter) || retailerFilter : null;
  const jurisdiction = jurisdictionFilter
    ? canonicalJurisdiction(jurisdictionFilter) ?? jurisdictionFilter
    : null;
  const fuel = fuelFilter ? canonicalFuel(fuelFilter) ?? fuelFilter : null;
  const customerType = customerTypeFilter
    ? canonicalCustomerType(customerTypeFilter) ?? customerTypeFilter
    : null;

  const rows = (await sql`
    SELECT schedule, period_label, period_start, period_end, retailer, jurisdiction,
           fuel, metric, metric_raw, value, source_file, sheet_name, cell_ref,
           COUNT(*)    OVER () AS total_count,
           SUM(value)  OVER () AS total_value,
           MAX(period_label) OVER () AS latest_period
    FROM aer_performance
    WHERE (${schedule}::smallint IS NULL OR schedule = ${schedule}::smallint)
      AND (${retailer}::text     IS NULL OR LOWER(retailer)     = LOWER(${retailer}))
      AND (${jurisdiction}::text IS NULL OR LOWER(jurisdiction) = LOWER(${jurisdiction}))
      AND (${fuel}::text         IS NULL OR LOWER(fuel)         = LOWER(${fuel}))
      AND (${customerType}::text IS NULL OR LOWER(customer_type) = LOWER(${customerType}))
      AND (${metric}::text       IS NULL OR metric              = ${metric})
      AND (${from}::date IS NULL OR period_start >= ${from}::date)
      AND (${to}::date   IS NULL OR period_end   <= ${to}::date)
    ORDER BY period_start DESC, retailer, metric
    LIMIT ${MAX_AER_ROWS}
  `) as Row[];

  const totalCount = rows[0] ? Number(rows[0].total_count) : 0;

  return {
    rows: rows.map(toObservation),
    totalCount,
    // SUM over no rows is null rather than 0.
    totalValue: rows[0]?.total_value != null ? Number(rows[0].total_value) : 0,
    truncated: totalCount > rows.length,
    latestPeriod: rows[0]?.latest_period ?? null,
  };
}

export interface AerFacets {
  schedules: number[];
  /** Canonical keys — what a filter must use. */
  retailers: string[];
  /**
   * Canonical key to the spellings the workbooks actually used, most recent
   * first. Without this the facets read as `agl_energy` and a caller has no
   * way to know which company that is, or that "AGL Energy Ltd" is the same
   * thing. The metric facets carry their aliases for exactly this reason.
   */
  retailerLabels: { retailer: string; spellings: string[] }[];
  jurisdictions: string[];
  fuels: string[];
  customerTypes: string[];
  /**
   * Canonical metrics with every header ever seen for each — the rename trail —
   * and the period each key first appeared in. `firstSeen` is what makes a new
   * metric visible as new: one that first appeared in the period just ingested
   * is either genuinely new reporting or a rename inference failed to match.
   */
  metrics: { metric: string; aliases: string[]; firstSeen: string }[];
  periods: string[];
  latestPeriod: string | null;
}

/**
 * The vocabulary actually present, returned with every result.
 *
 * Metrics come with their aliases so a question asked using last year's column
 * name still finds the series, and so a reader can see that a rename happened
 * rather than inferring it from a gap in the data.
 */
export async function aerFacets(): Promise<AerFacets> {
  const rows = (await sql`
    SELECT
      ARRAY(SELECT DISTINCT schedule FROM aer_performance ORDER BY schedule) AS schedules,
      ARRAY(SELECT DISTINCT retailer FROM aer_performance ORDER BY retailer) AS retailers,
      ARRAY(SELECT DISTINCT jurisdiction FROM aer_performance
             WHERE jurisdiction IS NOT NULL ORDER BY jurisdiction) AS jurisdictions,
      ARRAY(SELECT DISTINCT fuel FROM aer_performance
             WHERE fuel IS NOT NULL ORDER BY fuel) AS fuels,
      ARRAY(SELECT DISTINCT customer_type FROM aer_performance
             WHERE customer_type IS NOT NULL ORDER BY customer_type) AS customerTypes,
      ARRAY(SELECT DISTINCT period_label FROM aer_performance ORDER BY period_label DESC) AS periods,
      (SELECT MAX(period_label) FROM aer_performance) AS latest_period
  `) as {
    schedules: number[] | null;
    retailers: string[] | null;
    jurisdictions: string[] | null;
    fuels: string[] | null;
    customerTypes: string[] | null;
    periods: string[] | null;
    latest_period: string | null;
  }[];

  const metricRows = (await sql`
    SELECT metric, aliases, first_seen FROM aer_metrics ORDER BY metric
  `) as { metric: string; aliases: string[] | null; first_seen: string }[];

  // Most recent spelling first, so the label a caller sees is the one the
  // latest workbook used.
  const labelRows = (await sql`
    SELECT retailer,
           ARRAY_AGG(DISTINCT retailer_raw) FILTER (WHERE retailer_raw IS NOT NULL) AS spellings
    FROM aer_performance
    GROUP BY retailer
    ORDER BY retailer
  `) as { retailer: string; spellings: string[] | null }[];

  const row = rows[0];
  return {
    schedules: row?.schedules ?? [],
    retailers: row?.retailers ?? [],
    retailerLabels: labelRows.map((r) => ({
      retailer: r.retailer,
      spellings: r.spellings ?? [],
    })),
    jurisdictions: row?.jurisdictions ?? [],
    fuels: row?.fuels ?? [],
    customerTypes: row?.customerTypes ?? [],
    metrics: metricRows.map((m) => ({
      metric: m.metric,
      aliases: m.aliases ?? [],
      firstSeen: m.first_seen,
    })),
    periods: row?.periods ?? [],
    latestPeriod: row?.latest_period ?? null,
  };
}

/** The canonical vocabulary a schedule already knows, for the inference step. */
export async function knownMetrics(schedule: Schedule): Promise<AerMetric[]> {
  const rows = (await sql`
    SELECT schedule, metric, aliases, first_seen
    FROM aer_metrics WHERE schedule = ${schedule}
    ORDER BY metric
  `) as { schedule: number; metric: string; aliases: string[] | null; first_seen: string }[];

  return rows.map((r) => ({
    schedule: r.schedule as Schedule,
    metric: r.metric,
    aliases: r.aliases ?? [],
    firstSeen: r.first_seen,
  }));
}

/**
 * Records the metrics a workbook used, and reports which are new.
 *
 * A metric no previous quarter has seen is either genuinely new reporting or a
 * rename that inference failed to match. Those need a human glance, so this
 * returns them rather than absorbing them silently — the ingest result and the
 * UI both surface the list.
 *
 * An alias is appended, never replaced: the trail of headers a series has worn
 * is what lets a question asked with an old name still find it.
 */
export async function recordMetrics(
  schedule: Schedule,
  periodLabel: string,
  seen: { metric: string; raw: string }[]
): Promise<{ newMetrics: string[] }> {
  if (seen.length === 0) return { newMetrics: [] };

  const existing = new Set((await knownMetrics(schedule)).map((m) => m.metric));
  const newMetrics = [...new Set(seen.map((s) => s.metric))].filter((m) => !existing.has(m));

  for (const { metric, raw } of seen) {
    await sql`
      INSERT INTO aer_metrics (schedule, metric, aliases, first_seen)
      VALUES (${schedule}, ${metric}, ARRAY[${raw}]::text[], ${periodLabel})
      ON CONFLICT (schedule, metric) DO UPDATE
        SET aliases = CASE
              WHEN ${raw} = ANY(aer_metrics.aliases) THEN aer_metrics.aliases
              ELSE array_prepend(${raw}, aer_metrics.aliases)
            END
    `;
  }

  return { newMetrics };
}

/**
 * Replaces one (schedule, period) slice with a freshly parsed set.
 *
 * Idempotent per slice, the same discipline as `replaceDocumentGraph` and
 * `replaceActions`: re-ingesting a corrected workbook replaces that quarter
 * rather than doubling every number in it. Scoped to the slice so other
 * quarters and other schedules are untouched.
 */
/**
 * Replace every period this workbook carried.
 *
 * Takes a *set* of periods, not one, because a workbook states about five
 * quarters across its columns. Deleting only the release's own period while
 * inserting five would leave the other four holding whatever an earlier
 * release put there — no duplication, thanks to the observation index, but
 * stale numbers that a corrected workbook was supposed to replace.
 *
 * Ingest order therefore matters: two consecutive releases overlap by four
 * quarters, and the one ingested last wins for the overlap. That is the right
 * way round when releases are ingested in order, since a later release
 * restates earlier quarters — and `release_label` on every row records which
 * publication a number actually came from, so the question is answerable
 * either way.
 */
export async function replaceScheduleRows(
  schedule: Schedule,
  periodLabels: string[],
  rows: AerObservationRow[],
  mapping: unknown
): Promise<{ written: number; removed: number }> {
  if (periodLabels.length === 0) return { written: 0, removed: 0 };

  const removed = (await sql`
    DELETE FROM aer_performance
    WHERE schedule = ${schedule} AND period_label = ANY(${periodLabels})
    RETURNING cell_ref
  `) as { cell_ref: string }[];

  for (const row of rows) {
    await sql`
      INSERT INTO aer_performance (
        schedule, period_label, period_start, period_end, release_label,
        retailer, retailer_raw, jurisdiction, jurisdiction_raw, fuel, fuel_raw,
        customer_type, customer_type_raw, metric, metric_raw, value,
        source_file, sheet_name, cell_ref, mapping
      ) VALUES (
        ${row.schedule}, ${row.periodLabel}, ${row.periodStart}::date, ${row.periodEnd}::date,
        ${row.releaseLabel},
        ${row.retailer}, ${row.retailerRaw}, ${row.jurisdiction}, ${row.jurisdictionRaw},
        ${row.fuel}, ${row.fuelRaw}, ${row.customerType}, ${row.customerTypeRaw},
        ${row.metric}, ${row.metricRaw},
        ${row.value}, ${row.sourceFile}, ${row.sheetName}, ${row.cellRef},
        ${JSON.stringify(mapping)}::jsonb
      )
      ON CONFLICT (schedule, period_label, retailer, metric,
                   COALESCE(jurisdiction, ''), COALESCE(fuel, ''),
                   COALESCE(customer_type, ''))
      DO UPDATE SET
        value            = EXCLUDED.value,
        metric_raw       = EXCLUDED.metric_raw,
        retailer_raw       = EXCLUDED.retailer_raw,
        jurisdiction_raw   = EXCLUDED.jurisdiction_raw,
        fuel_raw           = EXCLUDED.fuel_raw,
        customer_type_raw  = EXCLUDED.customer_type_raw,
        release_label      = EXCLUDED.release_label,
        source_file = EXCLUDED.source_file,
        sheet_name  = EXCLUDED.sheet_name,
        cell_ref    = EXCLUDED.cell_ref,
        mapping     = EXCLUDED.mapping,
        ingested_at = NOW()
    `;
  }

  return { written: rows.length, removed: removed.length };
}

/**
 * Record the definitions one workbook stated, and report what changed.
 *
 * Keyed on the definition's own content, so a metric accumulates one row per
 * distinct meaning it has ever had. A `changed` outcome is the event
 * `aer_metrics.aliases` structurally cannot see: the name held, the series did
 * not break, and what the number counts moved.
 *
 * Degrades rather than aborting when the table is absent, like every other
 * optional table here — a run still stores its observations, it simply
 * captures no definitions and says so.
 */
export async function recordDefinitions(
  schedule: Schedule,
  periodLabel: string,
  sourceFile: string,
  captured: CapturedDefinition[]
): Promise<{ outcomes: DefinitionOutcome[]; missingTable: boolean }> {
  if (captured.length === 0) return { outcomes: [], missingTable: false };

  try {
    const existing = (await sql`
      SELECT metric, definition_key FROM aer_metric_definitions WHERE schedule = ${schedule}
    `) as { metric: string; definition_key: string }[];

    const outcomes = classifyDefinitions(
      captured,
      existing.map((r) => ({ metric: r.metric, definitionKey: r.definition_key }))
    );

    for (const entry of captured) {
      if (definitionProblem(entry.definition)) continue;
      const key = definitionKey(entry.definition);
      await sql`
        INSERT INTO aer_metric_definitions (
          schedule, metric, definition, definition_key, first_seen, last_seen,
          source_file, sheet_name, cell_ref
        ) VALUES (
          ${schedule}, ${entry.metric}, ${entry.definition}, ${key}, ${periodLabel},
          ${periodLabel}, ${sourceFile}, ${entry.sheetName}, ${entry.cellRef}
        )
        ON CONFLICT (schedule, metric, definition_key)
        -- Only the span moves. first_seen is never overwritten: it is the
        -- answer to "which quarters used this meaning", and a re-ingest of an
        -- old quarter must not rewrite history.
        DO UPDATE SET
          last_seen = GREATEST(aer_metric_definitions.last_seen, EXCLUDED.last_seen)
      `;
    }

    const changed = outcomes.filter((o) => o.status === "changed");
    if (changed.length > 0) {
      console.warn(
        `[recordDefinitions] ${changed.length} metric definition(s) CHANGED in ${periodLabel}: ` +
          changed.map((c) => c.metric).join(", ")
      );
    }
    return { outcomes, missingTable: false };
  } catch (error) {
    if (isMissingDefinitionsTable(error)) {
      console.warn(`[recordDefinitions] ${MISSING_DEFINITIONS_MESSAGE}`);
      return { outcomes: [], missingTable: true };
    }
    throw error;
  }
}
