// ---------------------------------------------------------------------------
// Reading observations out of a sheet, given a mapping
// ---------------------------------------------------------------------------
// The AER republishes these workbooks every quarter and the layout drifts, so
// a model infers the mapping. This file is the other half of that split, and
// the division is deliberate:
//
//   the model decides what a column *means*; this code reads what is *in* it.
//
// The model never emits a value. Not mainly for cost, though a Schedule 3
// workbook is thousands of rows — because a transcribed number can be wrong in
// a way nothing downstream detects. A hallucinated disconnection count for a
// named retailer, served through a tool that reports exact totals, is a
// fabricated regulatory statistic with a confident total attached. A wrong
// *mapping*, by contrast, is wrong consistently and a spot check catches it.
//
// Everything here is pure and works against `SheetLike`, not ExcelJS, so the
// half that has to be exactly right is verified with a plain object and no
// network, credentials or model in the loop.

/** The minimum a sheet has to offer. Adapted from ExcelJS at the call site. */
export interface SheetLike {
  name: string;
  rowCount: number;
  /** Cell value at a 1-based row and a column letter, or null when empty. */
  cell(row: number, column: string): string | number | null;
}

export interface SheetMapping {
  /** 1-based row the headers sit on. */
  headerRow: number;
  /** Column letters for the dimensions this sheet distinguishes. */
  dimensions: {
    retailer: string;
    jurisdiction?: string;
    fuel?: string;
  };
  metrics: {
    /** Column letter. */
    column: string;
    /** The header exactly as the workbook wrote it. */
    raw: string;
    /** Canonical key, stable across quarters. */
    metric: string;
  }[];
  /** Anything the model wants to say about how it read the sheet. */
  notes?: string;
}

export interface Observation {
  retailer: string;
  jurisdiction: string | null;
  fuel: string | null;
  metric: string;
  metricRaw: string;
  value: number;
  sheetName: string;
  /** e.g. "E42" — the cell this number came out of. */
  cellRef: string;
}

/** Rows read per sheet. A guard against a runaway `rowCount`, not a real limit. */
export const MAX_ROWS_PER_SHEET = 20_000;

/** Column letters are what a mapping names, since that is how a person reads a sheet. */
const COLUMN = /^[A-Z]{1,3}$/;

function text(value: string | number | null): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/**
 * A cell as a number, or null when it is not one.
 *
 * Deliberately refuses to coerce. `""` and `"n/a"` becoming `0` would be the
 * worst possible failure here — a retailer that did not report something would
 * silently acquire a zero, and zeros average and sum like any other number.
 * Percentages and thousands separators are unwrapped because AER writes them,
 * but anything else that does not parse cleanly is skipped.
 */
export function numericValue(value: string | number | null): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = text(value);
  if (!raw) return null;

  const cleaned = raw.replace(/,/g, "").replace(/\$/g, "").trim();
  // A lone dash or an explicit "not applicable" is an absence, not a zero.
  if (/^(-|–|—|n\/?a|nil|not applicable)$/i.test(cleaned)) return null;

  const percent = cleaned.endsWith("%");
  const body = percent ? cleaned.slice(0, -1) : cleaned;
  if (!/^-?\d*\.?\d+$/.test(body)) return null;

  const parsed = Number(body);
  if (!Number.isFinite(parsed)) return null;
  return percent ? parsed / 100 : parsed;
}

/**
 * Everything wrong with a mapping, as messages.
 *
 * Returned as prose because the only consumer is the repair prompt, which has
 * to read them. Checked against the sheet rather than in the abstract: a
 * mapping that names a column holding no header, or points at the wrong row,
 * is the failure that would otherwise produce thousands of plausible-looking
 * rows attributed to the wrong metric.
 */
export function mappingProblems(sheet: SheetLike, mapping: SheetMapping): string[] {
  const problems: string[] = [];

  if (!Number.isInteger(mapping.headerRow) || mapping.headerRow < 1) {
    problems.push(`headerRow must be a positive row number, got ${mapping.headerRow}`);
    return problems;
  }
  if (mapping.headerRow > sheet.rowCount) {
    problems.push(`headerRow ${mapping.headerRow} is past the end of the sheet (${sheet.rowCount} rows)`);
    return problems;
  }

  const retailer = mapping.dimensions?.retailer;
  if (!retailer || !COLUMN.test(retailer)) {
    problems.push(`dimensions.retailer must be a column letter, got ${JSON.stringify(retailer)}`);
  }

  for (const [name, column] of Object.entries(mapping.dimensions ?? {})) {
    if (column && !COLUMN.test(column)) {
      problems.push(`dimensions.${name} is not a column letter: ${JSON.stringify(column)}`);
    }
  }

  if (!Array.isArray(mapping.metrics) || mapping.metrics.length === 0) {
    problems.push("metrics is empty — no column was identified as a measure");
    return problems;
  }

  const seen = new Set<string>();
  for (const entry of mapping.metrics) {
    if (!COLUMN.test(entry.column ?? "")) {
      problems.push(`metric ${JSON.stringify(entry.raw)} has an invalid column ${JSON.stringify(entry.column)}`);
      continue;
    }
    if (!entry.metric || !entry.raw) {
      problems.push(`column ${entry.column} is missing a metric name`);
      continue;
    }
    if (seen.has(entry.column)) {
      problems.push(`column ${entry.column} is mapped more than once`);
    }
    seen.add(entry.column);

    // The header the mapping claims is there must actually be there. This is
    // the check that catches a headerRow off by one, which otherwise reads a
    // whole sheet against the wrong labels.
    const header = text(sheet.cell(mapping.headerRow, entry.column));
    if (!header) {
      problems.push(
        `column ${entry.column} is mapped to ${JSON.stringify(entry.raw)} but row ${mapping.headerRow} is empty there`
      );
    } else if (numericValue(header) !== null) {
      // A numeric "header" means headerRow is pointing at data — the classic
      // off-by-one. The empty check above misses it precisely because a data
      // row is not empty, and left alone it reads the whole sheet against
      // labels that are really measurements.
      problems.push(
        `row ${mapping.headerRow} column ${entry.column} holds the number ${header}, not a header — headerRow looks like it points at data`
      );
    }
  }

  return problems;
}

/**
 * Every observation the mapping names, read from the sheet.
 *
 * Rows below the header until the sheet runs out. A row with no retailer is
 * the end of a block or a spacer, not data; a cell that is not a number is
 * skipped rather than coerced.
 */
export function extractRows(sheet: SheetLike, mapping: SheetMapping): Observation[] {
  const rows: Observation[] = [];
  const limit = Math.min(sheet.rowCount, mapping.headerRow + MAX_ROWS_PER_SHEET);

  for (let row = mapping.headerRow + 1; row <= limit; row++) {
    const retailer = text(sheet.cell(row, mapping.dimensions.retailer));
    if (!retailer) continue;

    const jurisdiction = mapping.dimensions.jurisdiction
      ? text(sheet.cell(row, mapping.dimensions.jurisdiction)) || null
      : null;
    const fuel = mapping.dimensions.fuel
      ? text(sheet.cell(row, mapping.dimensions.fuel)) || null
      : null;

    for (const entry of mapping.metrics) {
      const value = numericValue(sheet.cell(row, entry.column));
      if (value === null) continue;

      rows.push({
        retailer,
        jurisdiction,
        fuel,
        metric: entry.metric,
        metricRaw: entry.raw,
        value,
        sheetName: sheet.name,
        cellRef: `${entry.column}${row}`,
      });
    }
  }

  return rows;
}

/**
 * The headers actually on the sheet, for the inference prompt and for the
 * mapping to be checked against.
 */
export function headersAt(sheet: SheetLike, headerRow: number, columns: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const column of columns) {
    const header = text(sheet.cell(headerRow, column));
    if (header) out[column] = header;
  }
  return out;
}
