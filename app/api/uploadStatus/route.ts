import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { parseStepName, parseWorkflowName } from "workflow/observability";
import { WorkflowRunNotFoundError } from "workflow/internal/errors";
import {
  INGEST_STEPS,
  stepsForWorkflow,
  type IngestRunProgress,
  type IngestRunStatus,
  type IngestStepProgress,
  type IngestStepStatus,
} from "@/lib/ingestSteps";

// Guards against a client asking about an unbounded number of runs in one poll.
const MAX_RUN_IDS = 25;

// The journal step whose presence means a failed run can be retried from its
// persisted markdown. Never surfaced as a progress step — see lib/ingestSteps.
const RESUME_POINT_STEP = "markResumePoint";

// GET /api/uploadStatus?runId=…&runId=… — per-step progress for in-flight
// ingestions. Runs are queried live from the workflow runtime; nothing about
// them is persisted, so a run the runtime has forgotten reports as "unknown".
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const runIds = req.nextUrl.searchParams.getAll("runId").filter(Boolean);

  if (runIds.length === 0) {
    return NextResponse.json(
      { success: false, error: "At least one runId is required" },
      { status: 400 }
    );
  }

  if (runIds.length > MAX_RUN_IDS) {
    return NextResponse.json(
      { success: false, error: `At most ${MAX_RUN_IDS} runIds may be requested` },
      { status: 400 }
    );
  }

  try {
    const runs = await Promise.all(runIds.map(readRunProgress));
    return NextResponse.json({ success: true, runs });
  } catch (error) {
    console.error("[uploadStatus] GET failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch ingestion status" },
      { status: 500 }
    );
  }
}

/**
 * The runtime prefixes a step failure with the machine step name and retry
 * count — `Step "step//./app/api/…//createEmbeddings" failed after 3 retries:
 * Upstash upsert rejected…`. The step's label and attempt count are already
 * shown alongside this message, so the prefix is pure noise; keep the part
 * that actually says what went wrong. The full text stays in the server log.
 */
function stripStepPrefix(message: string): string {
  return message.replace(/^Step "[^"]*" failed after \d+ retr(?:y|ies): /, "");
}

interface RawStep {
  status: IngestStepStatus;
  attempt: number;
  error: { message: string; code: string | null } | null;
  startedAt: string | null;
  completedAt: string | null;
}

async function readRunProgress(runId: string): Promise<IngestRunProgress> {
  const run = getRun(runId);

  let status: IngestRunStatus;
  let startedAt: Date | undefined;
  let completedAt: Date | undefined;
  let workflowName: string | null;

  try {
    // getRun() itself is synchronous; the getters are what discover a missing
    // run. A stale ID recovered from sessionStorage lands here routinely, so
    // it degrades to "unknown" rather than failing the whole poll.
    const [runStatus, started, completed, name] = await Promise.all([
      run.status,
      run.startedAt,
      run.completedAt,
      run.workflowName,
    ]);
    status = runStatus;
    startedAt = started;
    completedAt = completed;
    workflowName = parseWorkflowName(name)?.shortName ?? null;
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) {
      return unknownRun(runId);
    }
    throw error;
  }

  const steps = await readStepStatuses(runId);
  const expected = stepsForWorkflow(workflowName);

  const progress: IngestStepProgress[] = expected.map((step) => {
    const raw = steps.get(step.name);
    return {
      name: step.name,
      label: step.label,
      status: raw?.status ?? "pending",
      attempt: raw?.attempt ?? 1,
      error: raw?.error ?? null,
      startedAt: raw?.startedAt ?? null,
      completedAt: raw?.completedAt ?? null,
    };
  });

  const completedCount = progress.filter((s) => s.status === "completed").length;
  const currentStep = progress.find((s) => s.status === "running");
  const failedStep = progress.find((s) => s.status === "failed");

  return {
    runId,
    status,
    steps: progress,
    completedCount,
    totalCount: progress.length,
    currentStepLabel: currentStep?.label ?? null,
    failedStepLabel: failedStep?.label ?? null,
    error: failedStep?.error ?? null,
    // A run is only worth offering a retry for once it has actually failed.
    resumable:
      status === "failed" && steps.get(RESUME_POINT_STEP)?.status === "completed",
    workflowName,
    startedAt: startedAt?.toISOString() ?? null,
    completedAt: completedAt?.toISOString() ?? null,
  };
}

// Maps short step names ("extractGraph") to their latest reported state.
async function readStepStatuses(runId: string): Promise<Map<string, RawStep>> {
  const byName = new Map<string, RawStep>();

  // resolveData: "none" is essential, not an optimisation — a resolved step
  // input carries the whole PDF as a Uint8Array and the full markdown.
  const { data } = await getWorld().steps.list({
    runId,
    resolveData: "none",
  });

  for (const step of data) {
    // Step names are machine-readable ("step//./app/api/upload/steps/…//uploadPdf").
    const shortName = parseStepName(step.stepName)?.shortName;
    if (!shortName) continue;

    // A retried step appears more than once; the highest attempt is current.
    const existing = byName.get(shortName);
    if (existing && existing.attempt > step.attempt) continue;

    byName.set(shortName, {
      status: step.status,
      attempt: step.attempt,
      error: step.error
        ? { message: stripStepPrefix(step.error.message), code: step.error.code ?? null }
        : null,
      startedAt: step.startedAt?.toISOString() ?? null,
      completedAt: step.completedAt?.toISOString() ?? null,
    });
  }

  return byName;
}

function unknownRun(runId: string): IngestRunProgress {
  return {
    runId,
    status: "unknown",
    steps: INGEST_STEPS.map((step) => ({
      name: step.name,
      label: step.label,
      status: "pending" as const,
      attempt: 1,
      error: null,
      startedAt: null,
      completedAt: null,
    })),
    completedCount: 0,
    totalCount: INGEST_STEPS.length,
    currentStepLabel: null,
    failedStepLabel: null,
    error: null,
    resumable: false,
    workflowName: null,
    startedAt: null,
    completedAt: null,
  };
}
