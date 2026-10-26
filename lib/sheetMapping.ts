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

import { canonicalDimensions } from "@/lib/aerDimensions";
import { isAnnualPeriodLabel, normalizePeriodLabel } from "@/lib/aerPerformance";

/** The minimum a sheet has to offer. Adapted from ExcelJS at the call site. */
export interface SheetLike {
  name: string;
  rowCount: number;
  /** Cell value at a 1-based row and a column letter, or null when empty. */
  cell(row: number, column: string): string | number | null;
}

export interface SheetMapping {
  /**
   * 1-based row holding the metric names.
   *
   * Named `metricRow` rather than `headerRow` because a real AER sheet has
   * two header rows and calling either one "the header" is what produced the
   * original mistake.
   */
  metricRow: number;
  /**
   * 1-based row holding a period label per data column, or 0 when the sheet
   * reports one period.
   *
   * This is the discovery that forced the redesign. A Schedule 2 sheet looks
   * like this:
   *
   *   row 4:  National | Customer numbers | Customer numbers | ... | Market share
   *   row 5:  Retailer | Q4 2022-23       | Q1 2023-24       | ... | Q4 2022-23
   *
   * The columns are **quarters**, and one workbook carries five of them. Read
   * as one header row of metrics, the five "Customer numbers" columns collapse
   * onto a single `(period, retailer, metric, …)` key and four are silently
   * overwritten — leaving a real number from the wrong quarter under a
   * correct-looking label. 0 means the old single-period shape, which some
   * sheets in the same workbook still use.
   */
  periodRow: number;
  /** Column letters for dimensions that vary row by row. */
  dimensions: {
    retailer: string;
    jurisdiction?: string;
    fuel?: string;
    customerType?: string;
  };
  /**
   * Dimensions stated once for the whole sheet, as cell references.
   *
   * The other half of the same discovery: fuel sits in `B3`, customer segment
   * in `C3` and jurisdiction in `A4` — above the table, not in a column. Read
   * as absent, every row gets null for all three, and the Residential, Small
   * Business and Large sheets of one workbook share keys and overwrite each
   * other.
   */
  sheetDimensions?: {
    jurisdiction?: string;
    fuel?: string;
    customerType?: string;
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

/** "B3" → { column: "B", row: 3 }, or null. */
export function parseCellRef(ref: string): { column: string; row: number } | null {
  const m = String(ref).trim().toUpperCase().match(/^([A-Z]{1,3})([1-9]\d{0,6})$/);
  return m ? { column: m[1], row: Number(m[2]) } : null;
}

/** The first row of data, below whichever header row sits lowest. */
export function firstDataRow(mapping: SheetMapping): number {
  return Math.max(mapping.metricRow, mapping.periodRow) + 1;
}

export interface Observation {
  /**
   * The period this number measures, from the column's own header, or null
   * when the sheet states one period and the release label is it.
   */
  periodLabel: string | null;
  /** Canonical key, stable across quarters. What a query filters on. */
  retailer: string;
  /** Exactly as the workbook wrote it, so a wrong fold is recomputable. */
  retailerRaw: string;
  jurisdiction: string | null;
  jurisdictionRaw: string | null;
  fuel: string | null;
  fuelRaw: string | null;
  customerType: string | null;
  customerTypeRaw: string | null;
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

  if (!Number.isInteger(mapping.metricRow) || mapping.metricRow < 1) {
    problems.push(`metricRow must be a positive row number, got ${mapping.metricRow}`);
    return problems;
  }
  if (mapping.metricRow > sheet.rowCount) {
    problems.push(`metricRow ${mapping.metricRow} is past the end of the sheet (${sheet.rowCount} rows)`);
    return problems;
  }
  // 0 is the single-period shape. Anything else must be a real row, and must
  // not be the metric row — one row cannot be both the measure and the
  // quarter, and accepting that would reintroduce the collapse this redesign
  // exists to prevent.
  if (!Number.isInteger(mapping.periodRow) || mapping.periodRow < 0) {
    problems.push(`periodRow must be 0 or a positive row number, got ${mapping.periodRow}`);
    return problems;
  }
  if (mapping.periodRow > 0) {
    if (mapping.periodRow > sheet.rowCount) {
      problems.push(`periodRow ${mapping.periodRow} is past the end of the sheet (${sheet.rowCount} rows)`);
      return problems;
    }
    if (mapping.periodRow === mapping.metricRow) {
      problems.push(`periodRow and metricRow are both ${mapping.metricRow} — one row cannot be both`);
      return problems;
    }
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

  for (const [name, ref] of Object.entries(mapping.sheetDimensions ?? {})) {
    if (!ref) continue;
    const parsed = parseCellRef(ref);
    if (!parsed) {
      problems.push(`sheetDimensions.${name} is not a cell reference: ${JSON.stringify(ref)}`);
      continue;
    }
    // A sheet-level dimension pointing at an empty cell is worse than one
    // left out: it reads as "this sheet says nothing" when the real answer is
    // "we looked in the wrong place", and every row silently loses the
    // dimension.
    if (!text(sheet.cell(parsed.row, parsed.column))) {
      problems.push(`sheetDimensions.${name} points at ${ref}, which is empty`);
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
    // the check that catches a metricRow off by one, which otherwise reads a
    // whole sheet against the wrong labels.
    const header = text(sheet.cell(mapping.metricRow, entry.column));
    if (!header) {
      problems.push(
        `column ${entry.column} is mapped to ${JSON.stringify(entry.raw)} but row ${mapping.metricRow} is empty there`
      );
    } else if (numericValue(header) !== null) {
      // A numeric "header" means metricRow is pointing at data — the classic
      // off-by-one. The empty check above misses it precisely because a data
      // row is not empty, and left alone it reads the whole sheet against
      // labels that are really measurements.
      problems.push(
        `row ${mapping.metricRow} column ${entry.column} holds the number ${header}, not a header — metricRow looks like it points at data`
      );
    }

    // When the columns are quarters, every mapped column must carry one. A
    // column whose period cell is blank or unparseable would otherwise be
    // dropped silently at extraction; named here, it is a mapping to fix.
    if (mapping.periodRow > 0) {
      const periodCell = text(sheet.cell(mapping.periodRow, entry.column));
      if (!periodCell) {
        problems.push(
          `column ${entry.column} has no period in row ${mapping.periodRow} — the columns were read as quarters`
        );
      } else if (isAnnualPeriodLabel(periodCell)) {
        // Not a problem with the mapping. These sheets really do carry an
        // annual block to the right of the quarterly one, and `extractRows`
        // drops those columns. Treating it as a failure cost all six of
        // Schedule 2's main sheets on the first real ingest.
        continue;
      } else if (!normalizePeriodLabel(periodCell)) {
        problems.push(
          `column ${entry.column} period ${JSON.stringify(periodCell)} is not a quarter this app can read`
        );
      }
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
  const start = firstDataRow(mapping);
  const limit = Math.min(sheet.rowCount, start - 1 + MAX_ROWS_PER_SHEET);

  // Stated once above the table, so read once rather than per row.
  const sheetDim = (ref?: string): string | null => {
    if (!ref) return null;
    const parsed = parseCellRef(ref);
    if (!parsed) return null;
    return text(sheet.cell(parsed.row, parsed.column)) || null;
  };
  const sheetJurisdiction = sheetDim(mapping.sheetDimensions?.jurisdiction);
  const sheetFuel = sheetDim(mapping.sheetDimensions?.fuel);
  const sheetCustomerType = sheetDim(mapping.sheetDimensions?.customerType);

  // One lookup per column, not per cell: the period of column F is the same
  // for all three hundred retailers below it.
  const periodByColumn = new Map<string, string | null>();
  const annualColumns: string[] = [];
  if (mapping.periodRow > 0) {
    for (const entry of mapping.metrics) {
      const raw = text(sheet.cell(mapping.periodRow, entry.column));
      // An annual column is skipped rather than stored: it is the sum of the
      // quarters beside it, and an aggregate filed as an observation inflates
      // every total computed over the set. Collected so the count can be
      // reported — a silent drop of twenty columns is indistinguishable from a
      // mapping that never found them.
      if (raw && isAnnualPeriodLabel(raw)) {
        annualColumns.push(entry.column);
        continue;
      }
      periodByColumn.set(entry.column, raw ? normalizePeriodLabel(raw) : null);
    }
  }
  if (annualColumns.length > 0) {
    console.log(
      `[extractRows] ${sheet.name}: skipped ${annualColumns.length} annual column(s) ` +
        `(${annualColumns.slice(0, 8).join(", ")}${annualColumns.length > 8 ? ", …" : ""}) ` +
        `— they aggregate the quarters beside them`
    );
  }

  for (let row = start; row <= limit; row++) {
    const retailerRaw = text(sheet.cell(row, mapping.dimensions.retailer));
    if (!retailerRaw) continue;

    // A column wins over the sheet-level cell: if a sheet both states a fuel
    // above the table and breaks it down per row, the row is the finer truth.
    const jurisdictionRaw = mapping.dimensions.jurisdiction
      ? text(sheet.cell(row, mapping.dimensions.jurisdiction)) || null
      : sheetJurisdiction;
    const fuelRaw = mapping.dimensions.fuel
      ? text(sheet.cell(row, mapping.dimensions.fuel)) || null
      : sheetFuel;
    const customerTypeRaw = mapping.dimensions.customerType
      ? text(sheet.cell(row, mapping.dimensions.customerType)) || null
      : sheetCustomerType;

    const dims = canonicalDimensions(retailerRaw, jurisdictionRaw, fuelRaw, customerTypeRaw);

    // A "Total" or "All retailers" row is not an observation. Stored, it would
    // be summed together with the parts it is the total of, and every total
    // `search_aer_performance` reports would come back roughly double — with
    // the exactness the tool advertises.
    if (dims.skip) continue;

    for (const entry of mapping.metrics) {
      const value = numericValue(sheet.cell(row, entry.column));
      if (value === null) continue;

      // When the columns are quarters, a column whose header does not parse
      // as one is skipped rather than filed under the release's period. That
      // would be a real number under the wrong three months, which is the
      // failure this whole shape exists to prevent.
      let periodLabel: string | null = null;
      if (mapping.periodRow > 0) {
        periodLabel = periodByColumn.get(entry.column) ?? null;
        if (!periodLabel) continue;
      }

      rows.push({
        periodLabel,
        retailer: dims.retailer,
        retailerRaw: dims.retailerRaw,
        jurisdiction: dims.jurisdiction,
        jurisdictionRaw: dims.jurisdictionRaw,
        fuel: dims.fuel,
        fuelRaw: dims.fuelRaw,
        customerType: dims.customerType,
        customerTypeRaw: dims.customerTypeRaw,
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
