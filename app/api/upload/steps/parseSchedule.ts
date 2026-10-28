import { FatalError } from "workflow";
import { generateText, Output } from "ai";
import * as z from "zod/v4";
import {
  extractRows,
  mappingProblems,
  type SheetLike,
  type SheetMapping,
} from "@/lib/sheetMapping";
import { SHEET_MAPPING_MODEL, anthropicByok } from "@/lib/models";
import { mapPool } from "@/lib/pool";
import {
  MAX_DEFINITION_CHARS,
  definitionProblem,
  type CapturedDefinition,
} from "@/lib/aerDefinitions";
import {
  canonicalMetric,
  periodBounds,
  SCHEDULE_SUBJECTS,
  MAX_OBSERVATIONS_PER_INGEST,
  type AerObservationRow,
  type Schedule,
} from "@/lib/aerPerformance";
import {
  knownMetrics,
  recordDefinitions,
  recordMetrics,
  recordSheetMappings,
  replaceScheduleRows,
} from "@/lib/aerPerformanceStore";

// ---------------------------------------------------------------------------
// Steps: read an AER schedule workbook into observations
// ---------------------------------------------------------------------------
// The AER republishes Schedules 2, 3 and 4 every quarter and the layout
// drifts — columns move, and occasionally one is renamed. So a model decides
// what each column *means*, and this code reads what is *in* it. The model
// never emits a value: a transcribed number can be wrong in a way nothing
// downstream detects, and a fabricated disconnection count served through a
// tool that reports exact totals is the worst failure available here.
//
// Three steps rather than one, because step boundaries are cost boundaries
// (see .claude/rules/workflow-steps.md). Inference is the only step that calls
// a model, so a retry of the extraction must not re-pay for it, and a failed
// database write must not re-pay for either.

/** Rows of each sheet shown to the model. Enough for a header and some data. */
/**
 * Sheets inferred at once.
 *
 * Five rather than all of them, and not one at a time: a workbook carries up
 * to 29 sheets and the step that infers them has 300 seconds, so serial calls
 * do not fit. Five is the same width `contextualizeChunks` and `extractGraph`
 * fan out to.
 */
const INFERENCE_CONCURRENCY = 5;

const PREVIEW_ROWS = 30;
/** Columns scanned. AER schedules are wide but not this wide. */
const PREVIEW_COLUMNS = 40;

export interface SheetPreview {
  name: string;
  rowCount: number;
  /** The top of the sheet as text, with row numbers and column letters intact. */
  text: string;
}

function columnLetter(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** ExcelJS worksheet as the plain grid lib/sheetMapping works against. */
function asSheetLike(worksheet: {
  name: string;
  rowCount: number;
  getRow: (r: number) => { getCell: (c: number) => { value: unknown } };
}): SheetLike {
  return {
    name: worksheet.name,
    rowCount: worksheet.rowCount,
    cell(row, column) {
      let index = 0;
      for (const ch of column) index = index * 26 + (ch.charCodeAt(0) - 64);
      const raw = worksheet.getRow(row).getCell(index).value;
      if (raw === null || raw === undefined) return null;
      // A formula cell carries its computed result; that is the number on the
      // page, which is what a reader of the published workbook sees.
      if (typeof raw === "object" && raw !== null && "result" in raw) {
        const result = (raw as { result?: unknown }).result;
        return typeof result === "number" || typeof result === "string" ? result : null;
      }
      if (raw instanceof Date) return raw.toISOString().slice(0, 10);
      return typeof raw === "number" || typeof raw === "string" ? raw : String(raw);
    },
  };
}

async function openWorkbook(blobUrl: string) {
  const res = await fetch(blobUrl);
  // A workbook that cannot be fetched is not something a retry fixes.
  if (!res.ok) throw new FatalError(`Schedule fetch failed: ${res.status} ${blobUrl}`);

  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await res.arrayBuffer());
  return workbook;
}

/**
 * Step 1: the top of every sheet, as text.
 *
 * Small enough to sit in the workflow journal, unlike the workbook itself —
 * a Schedule 3 file runs to megabytes, and persisting it per step would store
 * it many times over.
 */
export async function readSheetPreviews(blobUrl: string): Promise<SheetPreview[]> {
  "use step";

  const workbook = await openWorkbook(blobUrl);
  const previews: SheetPreview[] = [];

  workbook.eachSheet((worksheet) => {
    const sheet = asSheetLike(worksheet as never);
    const lines: string[] = [];

    for (let row = 1; row <= Math.min(sheet.rowCount, PREVIEW_ROWS); row++) {
      const cells: string[] = [];
      for (let c = 1; c <= PREVIEW_COLUMNS; c++) {
        const letter = columnLetter(c);
        const value = sheet.cell(row, letter);
        if (value !== null && String(value).trim()) {
          cells.push(`${letter}: ${String(value).trim().slice(0, 80)}`);
        }
      }
      if (cells.length > 0) lines.push(`row ${row} | ${cells.join(" | ")}`);
    }

    previews.push({ name: sheet.name, rowCount: sheet.rowCount, text: lines.join("\n") });
  });

  return previews;
}

/** What one workbook's inference yields: the mappings, and what it means. */
export interface InferenceResult {
  mappings: { sheetName: string; mapping: SheetMapping }[];
  definitions: CapturedDefinition[];
}

const MappingSchema = z.object({
  isData: z.boolean(),
  metricRow: z.number().default(0),
  periodRow: z.number().default(0),
  retailerColumn: z.string().default(""),
  jurisdictionColumn: z.string().default(""),
  fuelColumn: z.string().default(""),
  customerTypeColumn: z.string().default(""),
  jurisdictionCell: z.string().default(""),
  fuelCell: z.string().default(""),
  customerTypeCell: z.string().default(""),
  metrics: z
    .array(
      z.object({
        column: z.string(),
        header: z.string(),
        matchesKnownMetric: z.string().default(""),
      })
    )
    .default([]),
  // Captured even when isData is false, because a definitions page is exactly
  // the sheet this prompt rejects as data and exactly where the AER states
  // what each metric counts. No `.min`/`.max` anywhere, per the workflow-steps
  // rule: Gemini drops those constraints and still rejects the response.
  definitions: z
    .array(z.object({ term: z.string(), definition: z.string() }))
    .default([]),
  notes: z.string().default(""),
});

function prompt(schedule: Schedule, preview: SheetPreview, known: { metric: string; aliases: string[] }[]): string {
  const vocabulary = known.length
    ? known.map((k) => `- ${k.metric} (seen as: ${k.aliases.join("; ")})`).join("\n")
    : "(none yet — this is the first workbook for this schedule)";

  return `This is the top of a sheet from an AER retail performance workbook, Schedule ${schedule}, which covers ${SCHEDULE_SUBJECTS[schedule]}.

Sheet name: ${preview.name}
${preview.text}

Decide first whether this sheet holds reported data. A cover page, a contents list, a notes or definitions page, or a legend is NOT data: return isData false.

Whether or not it is data, report "definitions": any place this sheet states what a reported measure *means* — a definitions or notes page, a glossary, or an explanatory note under a column heading. Each entry is { term, definition } where "term" is the measure's name as written and "definition" is what the sheet says it counts.

Copy the definition text EXACTLY as it appears. Do not summarise it, do not rewrite it, do not complete a sentence that is cut off, and do not supply a definition from your own knowledge of the energy market. If the sheet states no definitions, return an empty array. A definition you compose is worse than none: it would be stored as the AER's own wording for a regulatory measure.

These workbooks commonly use TWO header rows, and getting this wrong is the most damaging mistake available here. A typical sheet:

  row 3:  Q4 2022-23 to Q4 2023-24 | Electricity      | Residential
  row 4:  National                 | Customer numbers | Customer numbers | ... | Market share
  row 5:  Retailer                 | Q4 2022-23       | Q1 2023-24       | ... | Q4 2022-23
  row 6:  1st Energy               | 25576            | 25240            | ... | 0.0037

Here the measure is on row 4 and each column is a different QUARTER, named on row 5 — one workbook carries five quarters. Note also that the fuel, the customer segment and the jurisdiction are stated in single cells ABOVE the table, not in columns.

If it is data, identify:
- "metricRow": the row number holding the measure names (row 4 above). Measures are words; a row of numbers is data, not a header.
- "periodRow": the row number holding a period per column, e.g. "Q4 2023-24" (row 5 above). Use 0 ONLY if the sheet reports a single period with no per-column quarters.
- "retailerColumn": the column letter holding the retailer or business name.
- "metrics": every column that holds a measurement, as { column, header, matchesKnownMetric }. When the columns are quarters, list EVERY one — five "Customer numbers" columns are five entries, not one.
- "jurisdictionColumn" / "fuelColumn" / "customerTypeColumn": the column letter, when the value varies row by row; "" otherwise.
- "jurisdictionCell" / "fuelCell" / "customerTypeCell": the cell reference (e.g. "B3") when the value is stated once for the whole sheet; "" otherwise. In the example these are "A4", "B3" and "C3".

Give a column letter OR a cell reference for each dimension, never both. Customer segment means Residential / Small Business / Large.

For "matchesKnownMetric": these metrics are already recorded for this schedule from earlier quarters.

${vocabulary}

If a column is the same measurement as one of those under a different wording — the AER renames columns between quarters — set matchesKnownMetric to that exact key. This matters: an unmatched rename splits one series into two, and a query then returns half the history. If it is genuinely a new measurement, leave matchesKnownMetric empty.

Report only the columns actually on this sheet. Do not report values, and do not infer columns that are not there.`;
}

/**
 * Step 2: what each column means.
 *
 * The one step that calls a model, isolated so a retry downstream does not
 * re-pay for it. Returns a mapping per data sheet; sheets the model judges to
 * be cover pages or notes are absent.
 */
export async function inferMappings(
  schedule: Schedule,
  previews: SheetPreview[]
): Promise<InferenceResult> {
  "use step";

  const known = (await knownMetrics(schedule)).map((m) => ({ metric: m.metric, aliases: m.aliases }));

  // ---------------------------------------------------------------------
  // One call per sheet, fanned out — not a sequential loop
  // ---------------------------------------------------------------------
  // This used to await each sheet in turn, inside one step, and a workbook has
  // more sheets than that can survive: Schedule 2 Q4 2023-24 has **16**, and
  // Schedule 3 has **29**. A serverless function is capped at 300 seconds, so
  // sixteen serial model calls at twenty seconds each is already over the line
  // and twenty-nine is hopeless — the step would time out, retry, and time out
  // again, having re-paid for every sheet it had already inferred.
  //
  // Concurrency instead, the same `mapPool` the other fan-out steps use. Five
  // at a time keeps a workbook inside one function's budget while staying well
  // under any provider rate limit, and because `mapPool` returns results in
  // input order the mappings and definitions still come out in sheet order —
  // which matters, since `extractAndStore` reports skipped sheets by name and
  // a shuffled report is a harder thing to read.
  const perSheet = await mapPool(previews, INFERENCE_CONCURRENCY, async (preview) => {
    const empty = {
      mapping: null as { sheetName: string; mapping: SheetMapping } | null,
      definitions: [] as CapturedDefinition[],
    };
    if (!preview.text.trim()) return empty;

    try {
      const { output } = await generateText({
        model: SHEET_MAPPING_MODEL,
        providerOptions: anthropicByok(SHEET_MAPPING_MODEL),
        output: Output.object({ schema: MappingSchema }),
        messages: [{ role: "user", content: prompt(schedule, preview, known) }],
      });

      // Definitions first, and outside the isData gate. The sheet that states
      // them is the one this prompt classifies as *not* data, so collecting
      // them after the gate would discard every one.
      const found: CapturedDefinition[] = [];
      for (const entry of output.definitions.slice(0, 400)) {
        const term = entry.term.trim();
        const definition = entry.definition.trim().slice(0, MAX_DEFINITION_CHARS);
        if (!term || definitionProblem(definition)) continue;
        found.push({
          // Matched to a canonical metric deterministically, not by the model:
          // the term is normalised the same way a header is, so a definition
          // lands on the metric its wording implies or on nothing at all.
          metric: canonicalMetric(term),
          definition,
          sheetName: preview.name,
          cellRef: null,
        });
      }

      if (!output.isData || output.metrics.length === 0) {
        return { mapping: null, definitions: found };
      }

      const mapping = {
        sheetName: preview.name,
        mapping: {
          metricRow: output.metricRow,
          periodRow: output.periodRow,
          dimensions: {
            retailer: output.retailerColumn.trim().toUpperCase(),
            jurisdiction: output.jurisdictionColumn.trim().toUpperCase() || undefined,
            fuel: output.fuelColumn.trim().toUpperCase() || undefined,
            customerType: output.customerTypeColumn.trim().toUpperCase() || undefined,
          },
          sheetDimensions: {
            jurisdiction: output.jurisdictionCell.trim().toUpperCase() || undefined,
            fuel: output.fuelCell.trim().toUpperCase() || undefined,
            customerType: output.customerTypeCell.trim().toUpperCase() || undefined,
          },
          metrics: output.metrics.slice(0, 200).map((m) => ({
            column: m.column.trim().toUpperCase(),
            raw: m.header.trim(),
            // A matched rename keeps the existing key; anything else gets its
            // own, derived from the header.
            metric: m.matchesKnownMetric.trim() || canonicalMetric(m.header),
          })),
          notes: output.notes || undefined,
        },
      };
      return { mapping, definitions: found };
    } catch (error) {
      // One unreadable sheet must not discard a workbook whose other sheets
      // parsed, so this degrades rather than aborting — the workflow-steps rule.
      // `mapPool` awaits every runner, so an unhandled throw here would sink
      // the whole workbook rather than one sheet.
      console.warn(`[parseSchedule] sheet "${preview.name}": inference failed, skipping —`, error);
      return empty;
    }
  });

  const mappings = perSheet
    .map((r) => r.mapping)
    .filter((m): m is { sheetName: string; mapping: SheetMapping } => m !== null);
  const definitions = perSheet.flatMap((r) => r.definitions);

  console.log(
    `[parseSchedule] ${mappings.length} data sheets, ${definitions.length} definitions captured`
  );
  return { mappings, definitions };
}

/**
 * Step 3: read the cells those mappings name, and store them.
 *
 * Re-opens the workbook rather than receiving it, the same reason extractGraph
 * re-derives chunks from the markdown: passing it between steps would persist
 * megabytes into the journal once per step.
 *
 * A mapping that does not match its sheet is rejected before a single row is
 * written. It is not repaired here — a wrong mapping produces thousands of
 * plausible rows attributed to the wrong metric, and skipping the sheet with a
 * named warning is the safer failure.
 */
export async function extractAndStore(
  blobUrl: string,
  schedule: Schedule,
  periodLabel: string,
  sourceFile: string,
  inference: InferenceResult
): Promise<{
  written: number;
  removed: number;
  /** Observations read but not stored, because another took their key. */
  overwritten: number;
  /** Sheets whose mapping was accepted but which yielded nothing. */
  emptySheets: string[];
  newMetrics: string[];
  skipped: string[];
  definitionsCaptured: number;
  definitionsChanged: string[];
  /** Every period this workbook actually carried. Usually five, not one. */
  periods: string[];
}> {
  "use step";

  // `periodLabel` is the *release* — which publication this workbook is — and
  // no longer the period of every row in it. One workbook states five
  // quarters, each named on its own column, so the period travels per
  // observation and this label says where it was published.
  const releaseBounds = periodBounds(periodLabel);
  if (!releaseBounds) {
    throw new FatalError(
      `Could not read a period from "${periodLabel}". Expected something like "2023-24 Q3".`
    );
  }

  const { mappings, definitions } = inference;
  const workbook = await openWorkbook(blobUrl);
  const observations: AerObservationRow[] = [];
  const seenMetrics: { metric: string; raw: string }[] = [];
  const skipped: string[] = [];
  // Per sheet, because "29 sheets parsed" can hide ten that contributed
  // nothing. A sheet whose mapping is accepted and which then yields no rows
  // is the silent case: every column dropped as annual, every row refused as
  // an aggregate, or a retailer column pointing somewhere empty. None of
  // those raise, and none of them show up in `skipped` — that list is only
  // for mappings that failed validation.
  const perSheetRows: { sheetName: string; rows: number }[] = [];

  for (const { sheetName, mapping } of mappings) {
    const worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) {
      skipped.push(`${sheetName} (not found in the workbook)`);
      continue;
    }

    const sheet = asSheetLike(worksheet as never);
    const problems = mappingProblems(sheet, mapping);
    if (problems.length > 0) {
      console.warn(`[parseSchedule] sheet "${sheetName}" mapping rejected: ${problems.join("; ")}`);
      skipped.push(`${sheetName} (${problems[0]})`);
      continue;
    }

    const before = observations.length;

    for (const row of extractRows(sheet, mapping)) {
      // The column's own quarter where the sheet gives one, the release
      // otherwise. Bounds are derived from whichever applies, so a date-range
      // query cannot land on the release when the number measures something
      // else.
      const rowPeriod = row.periodLabel ?? periodLabel;
      const bounds = row.periodLabel ? periodBounds(row.periodLabel) : releaseBounds;
      if (!bounds) {
        // extractRows already refuses a column whose period will not parse,
        // so reaching here means the two disagree. Skip rather than guess.
        continue;
      }

      observations.push({
        schedule,
        periodLabel: rowPeriod,
        periodStart: bounds.start,
        periodEnd: bounds.end,
        releaseLabel: periodLabel,
        retailer: row.retailer,
        retailerRaw: row.retailerRaw,
        jurisdiction: row.jurisdiction,
        jurisdictionRaw: row.jurisdictionRaw,
        fuel: row.fuel,
        fuelRaw: row.fuelRaw,
        customerType: row.customerType,
        customerTypeRaw: row.customerTypeRaw,
        metric: row.metric,
        metricRaw: row.metricRaw,
        value: row.value,
        sourceFile,
        sheetName: row.sheetName,
        cellRef: row.cellRef,
      });
    }
    perSheetRows.push({ sheetName, rows: observations.length - before });
    for (const m of mapping.metrics) seenMetrics.push({ metric: m.metric, raw: m.raw });
  }

  // Named individually, not counted. A sheet that parsed and produced nothing
  // is either a sheet this app cannot read or one that genuinely holds no
  // observations, and only a person looking at the workbook can tell which —
  // so the name has to reach them.
  const emptySheets = perSheetRows.filter((s) => s.rows === 0).map((s) => s.sheetName);
  if (emptySheets.length > 0) {
    console.warn(
      `[parseSchedule] ${sourceFile}: ${emptySheets.length} sheet(s) parsed but produced no ` +
        `observations: ${emptySheets.join(", ")}. Their mappings were accepted, so this is not ` +
        "a rejected sheet — every candidate column or row was dropped."
    );
  }
  console.log(
    `[parseSchedule] ${sourceFile} per sheet: ` +
      perSheetRows.map((s) => `${s.sheetName}=${s.rows}`).join(", ")
  );

  if (observations.length > MAX_OBSERVATIONS_PER_INGEST) {
    throw new FatalError(
      `${observations.length} observations exceeds the ${MAX_OBSERVATIONS_PER_INGEST} cap — this does not look like a schedule workbook.`
    );
  }

  // Recorded before the rows, so a new metric is on the record even if the
  // write below fails partway and is retried.
  const { newMetrics } = await recordMetrics(schedule, periodLabel, seenMetrics);

  // Definitions before the observations, for the reason the metrics are: a
  // definition change is the finding, and it must survive a failed row write
  // and the retry that follows.
  const { outcomes } = await recordDefinitions(schedule, periodLabel, sourceFile, definitions);
  const definitionsChanged = outcomes.filter((o) => o.status === "changed").map((o) => o.metric);

  // Every period this workbook stated, not just the release's own. Deleting
  // one period while inserting five would leave the other four to accumulate
  // whatever an earlier release had put there.
  const periodsWritten = [...new Set(observations.map((o) => o.periodLabel))].sort();
  const { written, removed, overwritten, collisions } = await replaceScheduleRows(
    schedule,
    periodsWritten,
    observations
  );

  // Once per sheet, not once per observation. The previous shape put the whole
  // workbook's mappings on every row and filled the database; see
  // db/aer_sheet_mappings.sql.
  const mappingsRecorded = await recordSheetMappings(schedule, sourceFile, mappings);

  console.log(
    `[parseSchedule] ${sourceFile}: ${written} observation(s) across ${mappings.length - skipped.length} sheet(s)` +
      `, ${removed} replaced, ${newMetrics.length} new metric(s), ${skipped.length} sheet(s) skipped` +
      `, ${definitions.length} definition(s), ${definitionsChanged.length} changed` +
      `, periods ${periodsWritten.join("/") || "none"}`
  );

  // Named rather than silent, because a missing table here is invisible from
  // the data: the numbers all land and only the provenance is absent.
  if (mappingsRecorded.missingTable) {
    console.warn(
      `[parseSchedule] ${sourceFile}: column mappings not recorded — ` +
        "run db/aer_sheet_mappings.sql against the database"
    );
  }

  // Said separately and loudly, because it is the one number here that means
  // data did not survive. A mapping can send two columns to one observation
  // key, and Postgres resolves that by keeping the later one — so this is the
  // difference between what was read and what exists.
  if (overwritten > 0) {
    console.warn(
      `[parseSchedule] ${sourceFile}: ${overwritten} observation(s) overwrote another and are NOT ` +
        `stored — two columns or two sheets map to one observation key. ` +
        `First few: ${collisions.join("; ")}`
    );
  }

  return {
    written,
    removed,
    overwritten,
    emptySheets,
    newMetrics,
    skipped,
    periods: periodsWritten,
    definitionsCaptured: definitions.length,
    definitionsChanged,
  };
}
