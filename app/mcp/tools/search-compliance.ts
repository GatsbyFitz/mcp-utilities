import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  formatFine,
  isMissingComplianceTable,
  MISSING_COMPLIANCE_MESSAGE,
  type ComplianceAction,
} from "@/lib/compliance";
import { facets, queryActions, type ComplianceFacets } from "@/lib/complianceStore";

// ---------------------------------------------------------------------------
// search_compliance — enforcement actions as records
// ---------------------------------------------------------------------------
// Reads Postgres rather than the vector index, and that is the whole point.
// "How many times has ENGIE been fined" needs *every* matching row, and "total
// fines for family violence failures" needs arithmetic over them. Top-k
// similarity gives neither: it cannot promise it has them all, and it cannot
// add. On compliance questions a quietly incomplete answer is worse than none.
//
// The same actions are also embedded and graphed, so `search_docs` can find
// one by what it was about and `search_graph` can walk who was penalised by
// whom. This tool is for the questions those two answer badly.

function renderAction(action: ComplianceAction, n: number): string {
  const head = [
    action.organisation ?? "Unknown organisation",
    action.regulator ? `— ${action.regulator}` : null,
    action.actionDate ? `(${action.actionDate})` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const detail = [
    action.status,
    formatFine(action.fine),
    action.sector,
    action.misconductTypes.length > 0 ? action.misconductTypes.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const source = action.sourceUrl ? `\n${action.sourceUrl}` : "";
  return `[${n}] ${head}\n${action.summary}\n${detail}${source}`;
}

/** The vocabulary actually present, so a wrong guess can be corrected in one retry. */
function renderFacets(available: ComplianceFacets): string {
  const lines = [
    available.organisations.length > 0 ? `Organisations: ${available.organisations.join(", ")}` : null,
    available.sectors.length > 0 ? `Sectors: ${available.sectors.join(", ")}` : null,
    available.regulators.length > 0 ? `Regulators: ${available.regulators.join(", ")}` : null,
    available.statuses.length > 0 ? `Statuses: ${available.statuses.join(", ")}` : null,
    available.misconductTypes.length > 0
      ? `Misconduct types: ${available.misconductTypes.join(", ")}`
      : null,
  ].filter(Boolean);
  return lines.join("\n");
}

export function registerSearchComplianceTool(server: McpServer): void {
  server.registerTool(
    "search_compliance",
    {
      title: "search_compliance",
      description:
        "Search the compliance tracker: regulatory enforcement actions against " +
        "energy businesses — who was penalised, when, by which regulator, for " +
        "what, and how much they were fined. Use this for questions about " +
        "enforcement history, penalties and investigations, and for any " +
        "question needing a count or a total, because it returns every " +
        "matching row and computes the totals itself. Filters are matched " +
        "case-insensitively and every response lists the values actually " +
        "available, so if a filter returns nothing, retry using a value from " +
        "that list rather than concluding there were no actions. Answers here " +
        "are as current as the last sync, which each response states — say so " +
        "when recency matters. For what the rules themselves require, use " +
        "search_docs; for how parties relate across the corpus, search_graph.",
      inputSchema: z.object({
        organisation: z.string().max(200).optional(),
        sector: z.string().max(100).optional(),
        regulator: z.string().max(100).optional(),
        status: z.string().max(100).optional(),
        misconductType: z.string().max(200).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        minFine: z.number().nonnegative().optional(),
        query: z.string().max(500).optional(),
      }),
    },
    async ({ organisation, sector, regulator, status, misconductType, from, to, minFine, query }) => {
      try {
        const [result, available] = await Promise.all([
          queryActions({
            organisation,
            sector,
            regulator,
            status,
            misconductType,
            from,
            to,
            minFine,
            term: query,
          }),
          facets(),
        ]);

        const asOf = result.syncedAt ?? available.syncedAt;
        const currency = asOf ? `\nTracker last synced ${asOf}.` : "";

        if (result.actions.length === 0) {
          // "No matching rows" and "no such category" must never read alike.
          // Without the vocabulary here, a mistyped filter would be reported
          // to the reader as an organisation having a clean record.
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No enforcement actions match those filters. This means nothing ` +
                  `matched, not that no such actions exist — check the filter ` +
                  `values against what is actually recorded:\n\n${renderFacets(available)}${currency}`,
              },
            ],
            structuredContent: { actions: [], totalCount: 0, totalFine: 0, facets: available, syncedAt: asOf },
          };
        }

        const rendered = result.actions.map(renderAction).join("\n\n---\n\n");
        const capped = result.truncated
          ? `\nShowing ${result.actions.length} of ${result.totalCount}; the count and total above cover all of them.`
          : "";

        return {
          content: [
            {
              type: "text" as const,
              text:
                `${result.totalCount} enforcement action(s), totalling ` +
                `${formatFine(result.totalFine)} in fines.${capped}\n\n${rendered}\n\n` +
                `Available filter values:\n${renderFacets(available)}${currency}`,
            },
          ],
          structuredContent: {
            actions: result.actions,
            totalCount: result.totalCount,
            totalFine: result.totalFine,
            truncated: result.truncated,
            facets: available,
            syncedAt: asOf,
          },
        };
      } catch (error) {
        if (isMissingComplianceTable(error)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: MISSING_COMPLIANCE_MESSAGE }],
          };
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          isError: true,
          content: [{ type: "text" as const, text: `search_compliance failed: ${message}` }],
        };
      }
    }
  );
}
