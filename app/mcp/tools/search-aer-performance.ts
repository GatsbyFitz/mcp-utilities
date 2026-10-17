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
    f.retailers.length ? `Retailers: ${f.retailers.join(", ")}` : null,
    f.jurisdictions.length ? `Jurisdictions: ${f.jurisdictions.join(", ")}` : null,
    f.fuels.length ? `Fuels: ${f.fuels.join(", ")}` : null,
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
        "within a single metric. For enforcement actions and penalties use " +
        "search_compliance; for what the rules require use search_docs.",
      inputSchema: z.object({
        schedule: z.number().int().optional(),
        retailer: z.string().max(200).optional(),
        jurisdiction: z.string().max(50).optional(),
        fuel: z.string().max(50).optional(),
        metric: z.string().max(200).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    },
    async ({ schedule, retailer, jurisdiction, fuel, metric, from, to }) => {
      try {
        const [result, facets] = await Promise.all([
          queryAer({ schedule, retailer, jurisdiction, fuel, metric, from, to }),
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
            structuredContent: { rows: [], totalCount: 0, totalValue: 0, facets },
          };
        }

        const capped = result.truncated
          ? `\nShowing ${result.rows.length} of ${result.totalCount}; the count and total above cover all of them.`
          : "";
        // Only meaningful within one metric — summing customers and
        // disconnections together is arithmetic on unlike things.
        const total = metric
          ? `, totalling ${formatValue(result.totalValue)}`
          : " (no total shown: a total across different metrics would be meaningless)";

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
