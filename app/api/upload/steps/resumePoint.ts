import { BlobInfo } from "./recordUpload";
import {
  isMissingIngestionRunsTable,
  MISSING_INGESTION_RUNS_MESSAGE,
  recordResumePoint,
} from "@/lib/ingestionRuns";

// ---------------------------------------------------------------------------
// Marks the point past which a failed ingestion can be resumed
// ---------------------------------------------------------------------------

export interface ResumePoint {
  fileName: string;
  sizeBytes: number;
  blob: BlobInfo;
  markdownUrl: string;
}

/**
 * Records everything a resumed ingestion needs, immediately after the markdown
 * has been persisted, in two places.
 *
 * In the workflow journal, as one small step output: a retry reads *this* step
 * rather than one whose serialized input carries the whole markdown
 * (`resolveData` resolves a step's input and output together, so reading
 * `createEmbeddings` would pull the entire document back out).
 *
 * And in `ingestion_runs`, because the journal is only reachable through the
 * run id — which lives in the browser tab that started the upload and is gone
 * the moment it is refreshed. The row survives that, so the resume point is
 * findable by document name with no handle on the run at all.
 *
 * Either way its presence is exactly what makes a stalled run resumable: past
 * this point the expensive Gemini PDF→Markdown parse never has to run again. A
 * run that failed before it has no markdown to reuse.
 */
export async function markResumePoint(
  fileName: string,
  sizeBytes: number,
  blob: BlobInfo,
  markdownUrl: string
): Promise<ResumePoint> {
  "use step";

  const resume = { fileName, sizeBytes, blob, markdownUrl };

  try {
    await recordResumePoint(resume);
  } catch (error) {
    // A plain throw here is retryable and costs nothing — `createMarkdown` is
    // already banked in the journal, so a retry does not re-parse the PDF. The
    // one exception is the table simply not being provisioned yet: that never
    // resolves by retrying, and it must not take down ingestion, which worked
    // without this row before the table existed.
    if (!isMissingIngestionRunsTable(error)) throw error;
    console.warn(`[markResumePoint] ${MISSING_INGESTION_RUNS_MESSAGE}`);
  }

  return resume;
}
