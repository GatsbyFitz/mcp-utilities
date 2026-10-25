import { createHash } from "node:crypto";
import type { Schedule } from "@/lib/aerPerformance";

// ---------------------------------------------------------------------------
// Metric definitions: the blind spot the rename trail cannot see
// ---------------------------------------------------------------------------
// `metric` vs `metric_raw` and `aer_metrics.aliases` together survive a column
// being *renamed*. data-stores.md is candid about what they cannot survive:
//
//   "What none of this catches is a *definition* change under an unchanged
//    name. If 'Disconnections' keeps its name and changes what counts as one,
//    no name matching notices and nothing in the data can."
//
// Nothing in the data *could*, because the definition was never in the data.
// The AER states it — in the workbook's notes, and in the reporting
// guidelines — and the pipeline read past it.
//
// So it is captured, keyed by its own content. A second definition arriving
// for a metric that already has one is the event that was previously
// invisible: the series did not break, the name did not change, and what the
// number counts is no longer what it counted. That is a fact about the data
// nobody can recover later, because next quarter's workbook only states the
// new definition.
//
// What this is **not** is a model writing definitions. The same line the
// mapping respects applies here: inference reads the sheet and reports what it
// says; it does not compose. A definition is captured verbatim or not at all,
// and it carries the sheet and cell it was read from — so a definition that
// looks invented is checkable against the source, which is the only reason it
// is safe to store model-extracted prose about a regulatory measure at all.

/**
 * The identity of a definition's *content*.
 *
 * Normalised before hashing so that reflowed whitespace, a changed quote style
 * or a different trailing full stop is not reported as a changed definition.
 * Those happen between quarters constantly and mean nothing; reporting them
 * would bury the one change that does mean something.
 */
export function definitionKey(definition: string): string {
  const normalised = definition
    .normalize("NFKD")
    .replace(/[‐-―]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim()
    .toLowerCase();
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

/** How long a definition may be. Generous — these run to a paragraph. */
export const MAX_DEFINITION_CHARS = 4000;

/**
 * A definition that is not worth storing.
 *
 * The guard exists because an empty or near-empty string is what a model
 * returns for a sheet that states no definition, and storing those would fill
 * the table with rows that say nothing while looking like coverage.
 */
export function definitionProblem(definition: string): string | null {
  const trimmed = definition.trim();
  if (trimmed.length === 0) return "empty";
  // A bare repetition of the column header is not a definition.
  if (trimmed.length < 12) return "too short to be a definition";
  return null;
}

export interface AerMetricDefinition {
  schedule: Schedule;
  metric: string;
  definition: string;
  definitionKey: string;
  firstSeen: string;
  lastSeen: string;
  sourceFile: string;
  sheetName: string;
  cellRef: string | null;
}

/** A definition captured from a workbook, before it is stored. */
export interface CapturedDefinition {
  metric: string;
  definition: string;
  sheetName: string;
  cellRef: string | null;
}

/**
 * What storing a batch of captured definitions means for each metric.
 *
 * `restated` is the ordinary case: the same definition seen again, which only
 * moves `last_seen`. `changed` is the one worth a person's attention, and the
 * whole reason this exists.
 */
export interface DefinitionOutcome {
  metric: string;
  status: "new" | "restated" | "changed";
  definitionKey: string;
  /** For `changed`, the key it is superseding — so the pair is comparable. */
  previousKeys?: string[];
}

/**
 * Classify each captured definition against what is already recorded.
 *
 * Pure, so the decision that matters — "this metric's definition changed" —
 * is verifiable without a database.
 *
 * A metric with several recorded definitions is not an error: it is the
 * history. Only a key absent from that history is a change.
 */
export function classifyDefinitions(
  captured: CapturedDefinition[],
  existing: { metric: string; definitionKey: string }[]
): DefinitionOutcome[] {
  const byMetric = new Map<string, string[]>();
  for (const row of existing) {
    const keys = byMetric.get(row.metric) ?? [];
    keys.push(row.definitionKey);
    byMetric.set(row.metric, keys);
  }

  const seen = new Set<string>();
  const outcomes: DefinitionOutcome[] = [];
  for (const entry of captured) {
    if (definitionProblem(entry.definition)) continue;
    const key = definitionKey(entry.definition);
    // One workbook can state the same definition on several sheets.
    const dedupe = `${entry.metric}:${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const known = byMetric.get(entry.metric);
    if (!known || known.length === 0) {
      outcomes.push({ metric: entry.metric, status: "new", definitionKey: key });
    } else if (known.includes(key)) {
      outcomes.push({ metric: entry.metric, status: "restated", definitionKey: key });
    } else {
      outcomes.push({
        metric: entry.metric,
        status: "changed",
        definitionKey: key,
        previousKeys: known,
      });
    }
  }
  return outcomes;
}

export function isMissingDefinitionsTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /relation .*aer_metric_definitions.* does not exist/i.test(message);
}

export const MISSING_DEFINITIONS_MESSAGE =
  "The aer_metric_definitions table does not exist yet. Run db/aer_metric_definitions.sql " +
  "against the Neon database. Ingestion still works without it — definitions are simply " +
  "not captured, and a definition change stays invisible.";
