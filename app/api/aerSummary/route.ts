import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { isMissingAerTable, MISSING_AER_MESSAGE } from "@/lib/aerPerformance";
import { aerFacets, queryAer } from "@/lib/aerPerformanceStore";

/**
 * GET /api/aerSummary — what has been ingested from the AER schedules.
 *
 * Reads through the same `queryAer`/`aerFacets` the MCP tool uses rather than
 * its own SQL, so the page and `search_aer_performance` cannot disagree about
 * what is in the table. The count comes from a window function over the whole
 * match set, so it stays exact while the row list is capped.
 *
 * `newMetrics` is the part worth having here. A metric first seen in the most
 * recent period is either new reporting or a rename that inference did not
 * match to its predecessor, and an unmatched rename splits one series in two —
 * which a query answers with half the history and a confident total. So it is
 * computed from `first_seen` and shown, rather than left in the run's logs: a
 * client-side value from the ingest response would be gone on the next reload,
 * and this is a question someone asks a week later.
 */
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [result, facets] = await Promise.all([queryAer({}), aerFacets()]);
    const newMetrics = facets.latestPeriod
      ? facets.metrics.filter((m) => m.firstSeen === facets.latestPeriod).map((m) => m.metric)
      : [];

    return NextResponse.json({
      success: true,
      observations: result.totalCount,
      retailers: facets.retailers.length,
      metrics: facets.metrics.length,
      periods: facets.periods,
      schedules: facets.schedules,
      latestPeriod: facets.latestPeriod,
      newMetrics,
    });
  } catch (error) {
    if (isMissingAerTable(error)) {
      // Not an error for a deployment that has never ingested a schedule —
      // say what to run and return an empty summary, as /api/documentRequests
      // does for its own table.
      return NextResponse.json({
        success: true,
        observations: 0,
        retailers: 0,
        metrics: 0,
        periods: [],
        schedules: [],
        latestPeriod: null,
        newMetrics: [],
        notice: MISSING_AER_MESSAGE,
      });
    }
    console.error("[aerSummary] GET failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to read the AER schedules" },
      { status: 500 }
    );
  }
}
