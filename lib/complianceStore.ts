import { sql } from "@/lib/db";
import type { ComplianceAction } from "@/lib/compliance";

// ---------------------------------------------------------------------------
// Reading and writing the compliance_actions table
// ---------------------------------------------------------------------------
// Split from lib/compliance.ts so the vocabulary — the type, the id namespace,
// the kind and sourceDoc constants — can be imported without constructing a
// database client at module load, which `lib/db` does eagerly. The same split
// as lib/figures.ts and lib/figureCounts.ts, for the same reason: the pure
// half is what everything else depends on, including the tests.

export interface ComplianceFilters {
  organisation?: string;
  sector?: string;
  regulator?: string;
  status?: string;
  misconductType?: string;
  /** Inclusive ISO date bounds. */
  from?: string;
  to?: string;
  minFine?: number;
  /** Matched against the summary. */
  term?: string;
}

export interface ComplianceResult {
  actions: ComplianceAction[];
  /** Over the whole matching set, not just the returned page. */
  totalCount: number;
  totalFine: number;
  /** True when `actions` was capped and does not hold every matching row. */
  truncated: boolean;
  syncedAt: string | null;
}

/** Bound on rows returned. Counts and totals are computed over the full set regardless. */
const MAX_ACTIONS = 200;

interface ActionRow {
  page_id: string;
  summary: string;
  organisation: string | null;
  sector: string | null;
  action_date: string | Date | null;
  regulator: string | null;
  status: string | null;
  fine: string | number | null;
  source_url: string | null;
  misconduct_types: string[] | null;
  synced_at: string | Date;
  total_count: string | number;
  total_fine: string | number | null;
}

function toAction(row: ActionRow): ComplianceAction {
  return {
    pageId: row.page_id,
    summary: row.summary,
    organisation: row.organisation ?? null,
    sector: row.sector ?? null,
    actionDate: row.action_date ? new Date(row.action_date).toISOString().slice(0, 10) : null,
    regulator: row.regulator ?? null,
    status: row.status ?? null,
    fine: row.fine === null || row.fine === undefined ? null : Number(row.fine),
    sourceUrl: row.source_url ?? null,
    misconductTypes: row.misconduct_types ?? [],
  };
}

/**
 * Every action matching the filters, newest first.
 *
 * Each filter is optional inside one statement (`$n IS NULL OR …`) rather than
 * assembled by concatenation — the api-routes rule, and the only way to keep
 * every value a bound parameter.
 *
 * Counts and totals come from window functions over the *unlimited* match set,
 * so they stay exact even when the row list is capped. Summing the returned
 * rows instead would silently under-report the moment the cap was reached,
 * which is the one error this tool must not make.
 */
export async function queryActions(filters: ComplianceFilters): Promise<ComplianceResult> {
  const {
    organisation = null,
    sector = null,
    regulator = null,
    status = null,
    misconductType = null,
    from = null,
    to = null,
    minFine = null,
    term = null,
  } = filters;

  const rows = (await sql`
    SELECT page_id, summary, organisation, sector, action_date, regulator, status,
           fine, source_url, misconduct_types, synced_at,
           COUNT(*)  OVER () AS total_count,
           SUM(fine) OVER () AS total_fine
    FROM compliance_actions
    WHERE (${organisation}::text IS NULL OR LOWER(organisation) = LOWER(${organisation}))
      AND (${sector}::text       IS NULL OR LOWER(sector)       = LOWER(${sector}))
      AND (${regulator}::text    IS NULL OR LOWER(regulator)    = LOWER(${regulator}))
      AND (${status}::text       IS NULL OR LOWER(status)       = LOWER(${status}))
      AND (${misconductType}::text IS NULL OR EXISTS (
            SELECT 1 FROM unnest(misconduct_types) AS mt
            WHERE LOWER(mt) = LOWER(${misconductType})
          ))
      AND (${from}::date IS NULL OR action_date >= ${from}::date)
      AND (${to}::date   IS NULL OR action_date <= ${to}::date)
      AND (${minFine}::numeric IS NULL OR fine >= ${minFine}::numeric)
      AND (${term}::text IS NULL OR summary ILIKE '%' || ${term} || '%')
    ORDER BY action_date DESC NULLS LAST, page_id
    LIMIT ${MAX_ACTIONS}
  `) as ActionRow[];

  const totalCount = rows[0] ? Number(rows[0].total_count) : 0;

  return {
    actions: rows.map(toAction),
    totalCount,
    // SUM over no rows, or over only null fines, is null rather than 0.
    totalFine: rows[0]?.total_fine != null ? Number(rows[0].total_fine) : 0,
    truncated: totalCount > rows.length,
    syncedAt: rows[0] ? new Date(rows[0].synced_at).toISOString() : null,
  };
}

export interface ComplianceFacets {
  organisations: string[];
  sectors: string[];
  regulators: string[];
  statuses: string[];
  misconductTypes: string[];
  syncedAt: string | null;
}

/**
 * The values actually present, returned with every result.
 *
 * This is what lets a question phrased as "penalised for mistreating customers
 * in hardship" find its way to the three categories it matches none of by
 * string. The vocabulary cannot go in the tool description — that is fixed
 * when the tool registers, and this table changes on every sync — so it
 * travels in the response instead, where it is always the current set.
 */
export async function facets(): Promise<ComplianceFacets> {
  const rows = (await sql`
    SELECT
      ARRAY(SELECT DISTINCT organisation FROM compliance_actions
             WHERE organisation IS NOT NULL ORDER BY organisation) AS organisations,
      ARRAY(SELECT DISTINCT sector FROM compliance_actions
             WHERE sector IS NOT NULL ORDER BY sector) AS sectors,
      ARRAY(SELECT DISTINCT regulator FROM compliance_actions
             WHERE regulator IS NOT NULL ORDER BY regulator) AS regulators,
      ARRAY(SELECT DISTINCT status FROM compliance_actions
             WHERE status IS NOT NULL ORDER BY status) AS statuses,
      ARRAY(SELECT DISTINCT mt FROM compliance_actions,
             unnest(misconduct_types) AS mt ORDER BY mt) AS misconduct_types,
      (SELECT MAX(synced_at) FROM compliance_actions) AS synced_at
  `) as {
    organisations: string[] | null;
    sectors: string[] | null;
    regulators: string[] | null;
    statuses: string[] | null;
    misconduct_types: string[] | null;
    synced_at: string | Date | null;
  }[];

  const row = rows[0];
  return {
    organisations: row?.organisations ?? [],
    sectors: row?.sectors ?? [],
    regulators: row?.regulators ?? [],
    statuses: row?.statuses ?? [],
    misconductTypes: row?.misconduct_types ?? [],
    syncedAt: row?.synced_at ? new Date(row.synced_at).toISOString() : null,
  };
}

/** Replaces the table's contents with a freshly synced set, in one statement per step. */
export async function replaceActions(actions: ComplianceAction[]): Promise<{ synced: number; deleted: number }> {
  for (const action of actions) {
    await sql`
      INSERT INTO compliance_actions (
        page_id, summary, organisation, sector, action_date, regulator, status,
        fine, source_url, misconduct_types, synced_at
      ) VALUES (
        ${action.pageId}, ${action.summary}, ${action.organisation}, ${action.sector},
        ${action.actionDate}::date, ${action.regulator}, ${action.status},
        ${action.fine}, ${action.sourceUrl}, ${action.misconductTypes}::text[], NOW()
      )
      ON CONFLICT (page_id) DO UPDATE SET
        summary          = EXCLUDED.summary,
        organisation     = EXCLUDED.organisation,
        sector           = EXCLUDED.sector,
        action_date      = EXCLUDED.action_date,
        regulator        = EXCLUDED.regulator,
        status           = EXCLUDED.status,
        fine             = EXCLUDED.fine,
        source_url       = EXCLUDED.source_url,
        misconduct_types = EXCLUDED.misconduct_types,
        synced_at        = NOW()
    `;
  }

  // Anything no longer in Notion is gone from Notion. Leaving it here would
  // keep a retracted action answering questions as a current fact.
  const removed = (await sql`
    DELETE FROM compliance_actions
    WHERE NOT (page_id = ANY(${actions.map((a) => a.pageId)}::text[]))
    RETURNING page_id
  `) as { page_id: string }[];

  return { synced: actions.length, deleted: removed.length };
}
