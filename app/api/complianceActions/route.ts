import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { isMissingComplianceTable, MISSING_COMPLIANCE_MESSAGE } from "@/lib/compliance";
import { queryActions } from "@/lib/complianceStore";

/**
 * GET /api/complianceActions — the enforcement actions the last sync landed.
 *
 * Reads through `queryActions` with no filters rather than its own SQL, so the
 * page and `search_compliance` cannot disagree about what is in the table.
 *
 * The totals come back from that call and are passed through untouched: they
 * are computed with window functions over the whole matching set, so they stay
 * exact even when the row list is capped. Adding up the rows on screen instead
 * would under-report the moment the cap bit, and a compliance total that is
 * quietly low is worse than no total at all.
 */
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await queryActions({});
    return NextResponse.json({
      success: true,
      actions: result.actions,
      totalCount: result.totalCount,
      totalFine: result.totalFine,
      truncated: result.truncated,
      syncedAt: result.syncedAt,
    });
  } catch (error) {
    if (isMissingComplianceTable(error)) {
      // Not an error for a deployment that has never synced the tracker —
      // return an empty list and say what to run, exactly as
      // /api/documentRequests does for its own table.
      return NextResponse.json({
        success: true,
        actions: [],
        totalCount: 0,
        totalFine: 0,
        truncated: false,
        syncedAt: null,
        notice: MISSING_COMPLIANCE_MESSAGE,
      });
    }
    console.error("[complianceActions] GET failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to read the compliance tracker" },
      { status: 500 }
    );
  }
}
