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
  startedAt: string | null;
  completedAt: string | null;
}
