import { FatalError } from "workflow";
import { generateText, Output } from "ai";
import * as z from "zod/v4";
import {
  extractRows,
  mappingProblems,
  type SheetLike,
  type SheetMapping,
} from "@/lib/sheetMapping";
import {
  canonicalMetric,
  periodBounds,
  SCHEDULE_SUBJECTS,
  MAX_OBSERVATIONS_PER_INGEST,
  type AerObservationRow,
  type Schedule,
} from "@/lib/aerPerformance";
import { knownMetrics, recordMetrics, replaceScheduleRows } from "@/lib/aerPerformanceStore";

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

const MappingSchema = z.object({
  isData: z.boolean(),
  headerRow: z.number().default(0),
  retailerColumn: z.string().default(""),
  jurisdictionColumn: z.string().default(""),
  fuelColumn: z.string().default(""),
  metrics: z
    .array(z.object({ column: z.string(), header: z.string(), matchesKnownMetric: z.string().default("") }))
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

Decide first whether this sheet holds reported data. A cover page, a contents list, a notes or definitions page, or a legend is NOT data: return isData false and nothing else.

If it is data, identify:
- "headerRow": the row number the column headers are on. Headers are words; a row of numbers is data, not a header.
- "retailerColumn": the column letter holding the retailer or business name.
- "jurisdictionColumn": the column letter holding the state or jurisdiction, or "" if this sheet does not break figures down that way.
- "fuelColumn": the column letter for electricity/gas, or "" if not applicable.
- "metrics": every column that holds a measurement, as { column, header, matchesKnownMetric }.

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
): Promise<{ sheetName: string; mapping: SheetMapping }[]> {
  "use step";

  const known = (await knownMetrics(schedule)).map((m) => ({ metric: m.metric, aliases: m.aliases }));
  const mappings: { sheetName: string; mapping: SheetMapping }[] = [];

  for (const preview of previews) {
    if (!preview.text.trim()) continue;

    try {
      const { output } = await generateText({
        model: "google/gemini-3.5-flash-lite",
        output: Output.object({ schema: MappingSchema }),
        messages: [{ role: "user", content: prompt(schedule, preview, known) }],
      });

      if (!output.isData || output.metrics.length === 0) continue;

      mappings.push({
        sheetName: preview.name,
        mapping: {
          headerRow: output.headerRow,
          dimensions: {
            retailer: output.retailerColumn.trim().toUpperCase(),
            jurisdiction: output.jurisdictionColumn.trim().toUpperCase() || undefined,
            fuel: output.fuelColumn.trim().toUpperCase() || undefined,
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
      });
    } catch (error) {
      // One unreadable sheet must not discard a workbook whose other sheets
      // parsed, so this degrades rather than aborting — the workflow-steps rule.
      console.warn(`[parseSchedule] sheet "${preview.name}": inference failed, skipping —`, error);
    }
  }

  return mappings;
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
  mappings: { sheetName: string; mapping: SheetMapping }[]
): Promise<{ written: number; removed: number; newMetrics: string[]; skipped: string[] }> {
  "use step";

  const bounds = periodBounds(periodLabel);
  if (!bounds) {
    throw new FatalError(
      `Could not read a period from "${periodLabel}". Expected something like "2023-24 Q3".`
    );
  }

  const workbook = await openWorkbook(blobUrl);
  const observations: AerObservationRow[] = [];
  const seenMetrics: { metric: string; raw: string }[] = [];
  const skipped: string[] = [];

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

    for (const row of extractRows(sheet, mapping)) {
      observations.push({
        schedule,
        periodLabel,
        periodStart: bounds.start,
        periodEnd: bounds.end,
        retailer: row.retailer,
        jurisdiction: row.jurisdiction,
        fuel: row.fuel,
        metric: row.metric,
        metricRaw: row.metricRaw,
        value: row.value,
        sourceFile,
        sheetName: row.sheetName,
        cellRef: row.cellRef,
      });
    }
    for (const m of mapping.metrics) seenMetrics.push({ metric: m.metric, raw: m.raw });
  }

  if (observations.length > MAX_OBSERVATIONS_PER_INGEST) {
    throw new FatalError(
      `${observations.length} observations exceeds the ${MAX_OBSERVATIONS_PER_INGEST} cap — this does not look like a schedule workbook.`
    );
  }

  // Recorded before the rows, so a new metric is on the record even if the
  // write below fails partway and is retried.
  const { newMetrics } = await recordMetrics(schedule, periodLabel, seenMetrics);
  const { written, removed } = await replaceScheduleRows(schedule, periodLabel, observations, mappings);

  console.log(
    `[parseSchedule] ${sourceFile}: ${written} observation(s) across ${mappings.length - skipped.length} sheet(s)` +
      `, ${removed} replaced, ${newMetrics.length} new metric(s), ${skipped.length} sheet(s) skipped`
  );

  return { written, removed, newMetrics, skipped };
}
