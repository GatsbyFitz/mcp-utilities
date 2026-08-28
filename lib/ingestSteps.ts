// Shared vocabulary for reporting ingestion progress, used by
// `GET /api/uploadStatus` and by the upload page that polls it.
//
// The order below must match the order the steps are awaited in
// `app/api/upload/workflow.ts`. A step added there but not here is simply
// never reported — progress silently under-counts rather than erroring.

export const INGEST_STEPS = [
  { name: "uploadPdf", label: "Storing PDF" },
  { name: "createMarkdown", label: "Converting to Markdown" },
  { name: "uploadMarkdown", label: "Saving Markdown" },
  { name: "contextualizeChunks", label: "Contextualising chunks" },
  { name: "createEmbeddings", label: "Embedding" },
  { name: "extractGraph", label: "Extracting graph" },
  { name: "recordUpload", label: "Recording" },
] as const;

// A retry of a failed ingestion starts from the markdown that run already
// persisted, so it never re-uploads the PDF or re-runs the Gemini parse. Must
// match the awaits in `resumeIngest`.
export const RESUME_STEPS = [
  { name: "fetchMarkdown", label: "Loading saved Markdown" },
  { name: "contextualizeChunks", label: "Contextualising chunks" },
  { name: "createEmbeddings", label: "Embedding" },
  { name: "extractGraph", label: "Extracting graph" },
  { name: "recordUpload", label: "Recording" },
] as const;

/**
 * `markResumePoint` is deliberately absent from both lists — it writes only to
 * the journal and completes instantly, so surfacing it as a progress step
 * would be noise. Steps in the journal that no list names are ignored.
 */
export function stepsForWorkflow(
  workflowName: string | null
): readonly { name: string; label: string }[] {
  return workflowName === "resumeIngest" ? RESUME_STEPS : INGEST_STEPS;
}

export const INGEST_STEP_COUNT = INGEST_STEPS.length;

/** Step statuses as reported by the workflow runtime. */
export type IngestStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Run statuses as reported by the workflow runtime, plus `unknown` for a run
 * the runtime no longer knows about (a stale ID recovered from sessionStorage).
 */
export type IngestRunStatus = IngestStepStatus | "unknown";

const TERMINAL_RUN_STATUSES: readonly IngestRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "unknown",
];

/** A run in one of these states will never change again — stop polling it. */
export function isTerminalRunStatus(status: IngestRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export interface IngestStepProgress {
  name: string;
  label: string;
  status: IngestStepStatus;
  /** 1 on the first try; higher means the step is being retried. */
  attempt: number;
  /**
   * Why this step failed, straight from the workflow runtime. Present only on
   * a failed step. `stack` is deliberately not carried — it is in the server
   * log, and would dominate every poll response.
   */
  error: { message: string; code: string | null } | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface IngestRunProgress {
  runId: string;
  status: IngestRunStatus;
  /** One entry per entry in INGEST_STEPS, in order. */
  steps: IngestStepProgress[];
  completedCount: number;
  totalCount: number;
  /** Label of the step currently in flight, or null once nothing is running. */
  currentStepLabel: string | null;
  /** Label of the step that failed, when the run failed inside a known step. */
  failedStepLabel: string | null;
  /** The failing step's error, surfaced at run level for convenience. */
  error: { message: string; code: string | null } | null;
  /**
   * True when this failed run recorded a resume point — i.e. its markdown was
   * persisted, so POST /api/retryUpload can retry it without re-parsing the
   * PDF. False for a run that failed before the markdown existed.
   */
  resumable: boolean;
  /** Which workflow produced these steps: "ingestPdf" or "resumeIngest". */
  workflowName: string | null;
  startedAt: string | null;
  completedAt: string | null;
}
