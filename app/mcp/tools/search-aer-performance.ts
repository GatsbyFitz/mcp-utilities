import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  isMissingAerTable,
  MISSING_AER_MESSAGE,
  SCHEDULE_SUBJECTS,
  type AerObservationRow,
} from "@/lib/aerPerformance";
import { aerFacets, queryAer, type AerFacets } from "@/lib/aerPerformanceStore";

// ---------------------------------------------------------------------------
// search_aer_performance — the market, in numbers
// ---------------------------------------------------------------------------
// Reads Postgres rather than the vector index, for the reason search_compliance
// does: "how many disconnections did AGL report in Victoria last quarter"
// needs every matching row and arithmetic over them. Top-k similarity can
// neither promise it has them all nor add them up.
//
// Metrics are canonical keys, not the headers a particular workbook used. The
// AER renames columns between quarters, and a series split in two by a rename
// answers a question about a trend with half the data and no sign that
// anything is missing. The facets carry each metric's aliases so a question
// asked with last quarter's wording still lands on the right series.

/** A number as the schedules report it: counts are whole, rates are not. */
function formatValue(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-AU") : value.toLocaleString("en-AU", { maximumFractionDigits: 4 });
}

function renderRow(row: AerObservationRow, n: number): string {
  const where = [row.jurisdiction, row.fuel].filter(Boolean).join(", ");
  return (
    `[${n}] ${row.retailer}${where ? ` (${where})` : ""} — ${row.periodLabel}\n` +
    `${row.metric}: ${formatValue(row.value)}\n` +
    // Provenance on every row. For regulatory numbers "where did this come
    // from" has to be answerable, down to the cell.
    `reported as "${row.metricRaw}" · ${row.sourceFile} · ${row.sheetName}!${row.cellRef}`
  );
}

/** The vocabulary actually present, so a wrong filter is correctable in one retry. */
function renderFacets(f: AerFacets): string {
  const metricLines = f.metrics
    .map((m) => (m.aliases.length > 1 ? `${m.metric} (also published as: ${m.aliases.slice(1).join("; ")})` : m.metric))
    .join(", ");

  return [
    f.schedules.length ? `Schedules: ${f.schedules.join(", ")}` : null,
    // Canonical key first, because that is what a filter must use, then the
    // spellings the workbooks used — `agl_energy` alone tells a caller neither
    // which company it is nor that "AGL Energy Ltd" is the same series.
    f.retailers.length
      ? `Retailers (filter on the key; spellings in brackets): ${f.retailers
          .map((r) => {
            const seen = f.retailerLabels.find((l) => l.retailer === r)?.spellings ?? [];
            return seen.length ? `${r} (${seen.join("; ")})` : r;
          })
          .join(", ")}`
      : null,
    f.jurisdictions.length ? `Jurisdictions: ${f.jurisdictions.join(", ")}` : null,
    f.fuels.length ? `Fuels: ${f.fuels.join(", ")}` : null,
    f.customerTypes.length ? `Customer types: ${f.customerTypes.join(", ")}` : null,
    f.periods.length ? `Periods: ${f.periods.join(", ")}` : null,
    metricLines ? `Metrics: ${metricLines}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerSearchAerPerformanceTool(server: McpServer): void {
  server.registerTool(
    "search_aer_performance",
    {
      title: "search_aer_performance",
      description:
        "Search the AER retail performance schedules: what energy retailers " +
        "reported to the regulator each quarter. Schedule 2 covers " +
        `${SCHEDULE_SUBJECTS[2]}; Schedule 3 covers ${SCHEDULE_SUBJECTS[3]}; ` +
        `Schedule 4 covers ${SCHEDULE_SUBJECTS[4]}. Use this for anything ` +
        "quantitative about the market — how many customers a retailer has, " +
        "how many disconnections or complaints it reported, how a figure has " +
        "moved over time — because it returns every matching row and totals " +
        "them itself. Filter `metric` by a canonical key, not by the wording " +
        "on a particular spreadsheet: the AER renames columns between " +
        "quarters, and every response lists the metrics available together " +
        "with the other headings each has been published under, so if a " +
        "filter returns nothing, retry with a key from that list rather than " +
        "concluding the data does not exist. Totals are only meaningful " +
        "within a single metric, and within one jurisdiction scope: the AER " +
        "reports a National figure alongside the per-jurisdiction ones and " +
        "it is not their sum, so a total over both is a double count and is " +
        "reported as two figures rather than one. Filter `jurisdiction` " +
        "(\"National\", or a state) when you want a single total. For " +
        "enforcement actions and penalties use " +
        "search_compliance; for what the rules require use search_docs.",
      inputSchema: z.object({
        schedule: z.number().int().optional(),
        retailer: z.string().max(200).optional(),
        jurisdiction: z.string().max(50).optional(),
        fuel: z.string().max(50).optional(),
        customerType: z
          .string()
          .max(50)
          .optional()
          .describe("residential, small business or large — the segment the AER reports against."),
        metric: z.string().max(200).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    },
    async ({ schedule, retailer, jurisdiction, fuel, customerType, metric, from, to }) => {
      try {
        const [result, facets] = await Promise.all([
          queryAer({ schedule, retailer, jurisdiction, fuel, customerType, metric, from, to }),
          aerFacets(),
        ]);

        const asOf = facets.latestPeriod ? `\nLatest period ingested: ${facets.latestPeriod}.` : "";

        if (result.rows.length === 0) {
          // "Nothing matched" and "no such metric" must never read alike —
          // without the vocabulary here, a mistyped filter would be reported
          // as a retailer having reported nothing.
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No observations match those filters. This means nothing matched, ` +
                  `not that nothing was reported — check the values against what is ` +
                  `actually recorded:\n\n${renderFacets(facets)}${asOf}`,
              },
            ],
            structuredContent: {
              rows: [],
              totalCount: 0,
              totalValue: 0,
              nationalValue: null,
              subNationalValue: null,
              scopesMixed: false,
              facets,
            },
          };
        }

        const capped = result.truncated
          ? `\nShowing ${result.rows.length} of ${result.totalCount}; the count and total above cover all of them.`
          : "";
        // Two separate reasons a single total would be a wrong number rather
        // than a useful one. Both are said out loud, because this tool
        // advertises exact totals and a caller has no way to notice either.
        //
        // Across metrics it is arithmetic on unlike things — customers plus
        // disconnections. Across jurisdiction scopes it is a double count: the
        // AER reports a National figure *and* per-jurisdiction figures, and
        // the National one is not their sum, since Victorian retail reports to
        // the Essential Services Commission and has no block here. Adding them
        // gives roughly double. Both halves are given instead of one wrong
        // number, so nothing is lost and the reason is visible.
        const total = !metric
          ? " (no total shown: a total across different metrics would be meaningless)"
          : result.scopesMixed
            ? ` (no single total: these rows mix the National figure with per-jurisdiction ` +
              `figures, and National is not their sum, so adding them would double-count. ` +
              `National alone: ${formatValue(result.nationalValue ?? 0)}. Jurisdictions alone: ` +
              `${formatValue(result.subNationalValue ?? 0)}. Filter by jurisdiction for one total.)`
            : `, totalling ${formatValue(result.totalValue ?? 0)}`;

        return {
          content: [
            {
              type: "text" as const,
              text:
                `${result.totalCount} observation(s)${total}.${capped}\n\n` +
                `${result.rows.map(renderRow).join("\n\n---\n\n")}\n\n` +
                `Available filter values:\n${renderFacets(facets)}${asOf}`,
            },
          ],
          structuredContent: {
            rows: result.rows,
            totalCount: result.totalCount,
            totalValue: metric ? result.totalValue : null,
            nationalValue: metric ? result.nationalValue : null,
            subNationalValue: metric ? result.subNationalValue : null,
            scopesMixed: result.scopesMixed,
            truncated: result.truncated,
            facets,
          },
        };
      } catch (error) {
        if (isMissingAerTable(error)) {
          return { isError: true, content: [{ type: "text" as const, text: MISSING_AER_MESSAGE }] };
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          isError: true,
          content: [{ type: "text" as const, text: `search_aer_performance failed: ${message}` }],
        };
      }
    }
  );
}
