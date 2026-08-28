import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import {
  hydrateResourceIO,
  observabilityRevivers,
  parseStepName,
} from "workflow/observability";
import { resumeIngest } from "../upload/workflow";
import type { ResumePoint } from "../upload/steps/resumePoint";

const RESUME_POINT_STEP = "markResumePoint";

/**
 * POST /api/retryUpload  { runId }
 *
 * Retries a failed ingestion from the markdown it already persisted, rather
 * than from the original PDF. A failed run is terminal — the runtime will not
 * resume it in place — so this starts a fresh `resumeIngest` run seeded from
 * the failed run's own journal, skipping the upload and the Gemini parse.
 *
 * Returns the new run ID, which the client tracks in place of the old one.
 */
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { runId } = (await req.json().catch(() => ({}))) as { runId?: string };
  if (!runId) {
    return NextResponse.json({ success: false, error: "Missing runId" }, { status: 400 });
  }

  try {
    const world = getWorld();

    // resolveData: "none" — this listing is only used to find the resume
    // point's step ID; resolving here would pull every step's input, the PDF
    // bytes included.
    const { data: steps } = await world.steps.list({ runId, resolveData: "none" });

    const marker = steps.find(
      (step) =>
        parseStepName(step.stepName)?.shortName === RESUME_POINT_STEP &&
        step.status === "completed"
    );

    if (!marker) {
      // The run failed before its markdown was persisted, so there is nothing
      // cheaper to restart from — the PDF has to be uploaded again.
      return NextResponse.json(
        {
          success: false,
          error:
            "This run failed before its Markdown was saved, so there is nothing to resume from. Upload the file again.",
        },
        { status: 409 }
      );
    }

    // Only this one step is resolved: its input and output are both small,
    // unlike every other step in the run.
    const resolved = await world.steps.get(runId, marker.stepId, { resolveData: "all" });
    const hydrated = hydrateResourceIO(resolved, observabilityRevivers);
    const resume = hydrated.output as ResumePoint | undefined;

    if (!resume?.markdownUrl || !resume?.blob?.url || !resume?.fileName) {
      console.error("[retryUpload] resume point incomplete for run", runId, resume);
      return NextResponse.json(
        { success: false, error: "Saved resume point is unreadable; upload the file again" },
        { status: 409 }
      );
    }

    const run = await start(resumeIngest, [resume]);

    return NextResponse.json({
      success: true,
      runId: run.runId,
      fileName: resume.fileName,
      previousRunId: runId,
    });
  } catch (error) {
    console.error("[retryUpload] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to retry ingestion" },
      { status: 500 }
    );
  }
}
