import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { getRun } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/internal/errors";

/**
 * POST /api/cancelRun — stop an in-flight workflow run.
 *
 * `run.cancel()` records a `run_cancelled` event on the run's journal, so this
 * is cooperative rather than a kill: the run stops at the next step boundary
 * and a step already executing finishes and is paid for. Cancelling during a
 * Gemini parse does not stop that parse.
 *
 * Nothing is rolled back either. A cancelled ingestion can leave Markdown in
 * Blob, chunks in Upstash, edges in Neo4j and a row in `ingestion_runs` with no
 * `uploads` row — which is exactly the state `listIncompleteIngestions` and
 * `findStrandedMarkdown` exist to surface. The document shows up as an
 * incomplete ingestion and can be finished from its saved Markdown, so a cancel
 * costs the remaining steps rather than the work already done.
 */
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = (await req.json().catch(() => ({}))) as { runId?: string };
  if (!runId) {
    return NextResponse.json({ success: false, error: "Missing runId" }, { status: 400 });
  }

  try {
    const run = getRun(runId);

    // Checked first, and deliberately: `cancel()` does *not* throw for a run
    // the runtime has never heard of — it reports success. Without this, a
    // stale id out of sessionStorage would be answered with "cancelled" for a
    // run that does not exist. `exists` is the reliable probe; `status` throws
    // WorkflowRunNotFoundError instead of answering.
    if (!(await run.exists)) {
      return NextResponse.json(
        {
          success: false,
          error: "That run has finished or expired \u2014 there is nothing to cancel.",
        },
        { status: 404 }
      );
    }

    await run.cancel();
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isRunNotFound(error)) {
      // Backstop for a run that disappears between the check above and the
      // cancel, and for `exists` itself failing that way.
      return NextResponse.json(
        {
          success: false,
          error: "That run has finished or expired \u2014 there is nothing to cancel.",
        },
        { status: 404 }
      );
    }
    console.error("[cancelRun] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Could not cancel the run" },
      { status: 500 }
    );
  }
}

/**
 * `WorkflowRunNotFoundError`, however it arrives. The runtime wraps a
 * cancellation failure in a plain `Error("Failed to cancel run …", { cause })`,
 * so the original is not the thing thrown and `.is(error)` is false on its own.
 */
function isRunNotFound(error: unknown): boolean {
  if (WorkflowRunNotFoundError.is(error)) return true;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause !== undefined && WorkflowRunNotFoundError.is(cause);
}
