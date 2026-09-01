import { BlobInfo } from "./recordUpload";

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
 * Records everything a resumed ingestion needs, as one small step output in
 * the workflow journal, immediately after the markdown has been persisted.
 *
 * It writes nothing outside the journal — the point is purely that a retry can
 * read *this* step instead of a step whose serialized input carries the whole
 * markdown (`resolveData` resolves a step's input and output together, so
 * reading `createEmbeddings` would pull the entire document back out).
 *
 * Its presence in a failed run's journal is also exactly what makes that run
 * resumable: past this point the expensive Gemini PDF→Markdown parse never has
 * to run again. A run that failed before it has no markdown to reuse.
 */
export async function markResumePoint(
  fileName: string,
  sizeBytes: number,
  blob: BlobInfo,
  markdownUrl: string
): Promise<ResumePoint> {
  "use step";

  return { fileName, sizeBytes, blob, markdownUrl };
}
