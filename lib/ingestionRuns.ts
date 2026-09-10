import { sql } from "@/lib/db";
import { normalizeName } from "@/lib/upload";
import type { BlobInfo } from "@/app/api/upload/steps/recordUpload";
import type { ResumePoint } from "@/app/api/upload/steps/resumePoint";

// ---------------------------------------------------------------------------
// The work list of ingestions that started and never finished
// ---------------------------------------------------------------------------
// Nothing durable pointed at an in-flight ingestion before this table: the run
// id lived only in the browser tab that started it, `uploads` gets its row from
// the last step, and the resume point — the marker that says the expensive
// PDF→Markdown parse is already banked — lived only inside the workflow
// journal, reachable only through that same run id.
//
// So a refresh, or a lost tab, stranded the Markdown permanently even though it
// was sitting in Blob the whole time. `ingestion_runs` is the fix: a row from
// the moment a run starts, `markdown_url` filled in as soon as the parse lands,
// the row deleted when `recordUpload` writes the real `uploads` row.
//
// Rows are keyed by normalised file name, so a retry updates the same row
// rather than adding another, and two concurrent uploads of one name collide on
// the primary key instead of silently overwriting each other's chunks.

export interface IncompleteIngestion {
  fileName: string;
  sizeBytes: number;
  blob: BlobInfo;
  /** Null until `markResumePoint` runs — such a row has to start from the PDF. */
  markdownUrl: string | null;
  runId: string | null;
  startedAt: string;
  updatedAt: string;
}

/** The Postgres error raised when the table has never been created. */
export function isMissingIngestionRunsTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /relation .*ingestion_runs.* does not exist/i.test(message);
}

/** Names the file to run. Keep it a path someone can act on directly. */
export const MISSING_INGESTION_RUNS_MESSAGE =
  "The ingestion_runs table does not exist yet — run db/ingestion_runs.sql against the database.";

/** The primary key firing: this document is already being ingested. */
export function isConcurrentIngestion(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate key value/i.test(message) && /ingestion_runs/i.test(message);
}

interface IngestionRunRow {
  display_name: string;
  size_bytes: string | number;
  blob_url: string;
  blob_download_url: string;
  blob_path: string;
  markdown_url: string | null;
  run_id: string | null;
  started_at: string | Date;
  updated_at: string | Date;
}

function toIngestion(row: IngestionRunRow): IncompleteIngestion {
  return {
    fileName: row.display_name,
    sizeBytes: Number(row.size_bytes),
    blob: {
      url: row.blob_url,
      downloadUrl: row.blob_download_url,
      pathname: row.blob_path,
    },
    markdownUrl: row.markdown_url,
    runId: row.run_id,
    startedAt: new Date(row.started_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Claims a document for ingestion, before the workflow is started.
 *
 * Deliberately not an upsert on first claim: the primary key is the in-flight
 * duplicate guard, and a caller that loses the race needs to know it lost. A
 * *retry* of a row that already exists goes through `attachRun` instead.
 */
export async function beginIngestionRun(file: {
  fileName: string;
  sizeBytes: number;
  blob: BlobInfo;
}): Promise<void> {
  await sql`
    INSERT INTO ingestion_runs (
      name, display_name, size_bytes, blob_url, blob_download_url, blob_path
    ) VALUES (
      ${normalizeName(file.fileName)}, ${file.fileName}, ${file.sizeBytes},
      ${file.blob.url}, ${file.blob.downloadUrl}, ${file.blob.pathname}
    )
  `;
}

/** Points a row at the run now working on it. Called on start and on every retry. */
export async function attachRun(fileName: string, runId: string): Promise<void> {
  await sql`
    UPDATE ingestion_runs
    SET run_id = ${runId}, updated_at = NOW()
    WHERE name = ${normalizeName(fileName)}
  `;
}

/**
 * Records that the PDF→Markdown parse is banked.
 *
 * Written from inside the workflow, so it is an upsert: a run started before
 * this table existed, or one whose claim row was cleaned up, still has to be
 * able to land its resume point rather than fail the step.
 */
export async function recordResumePoint(resume: ResumePoint): Promise<void> {
  await sql`
    INSERT INTO ingestion_runs (
      name, display_name, size_bytes, blob_url, blob_download_url, blob_path, markdown_url
    ) VALUES (
      ${normalizeName(resume.fileName)}, ${resume.fileName}, ${resume.sizeBytes},
      ${resume.blob.url}, ${resume.blob.downloadUrl}, ${resume.blob.pathname}, ${resume.markdownUrl}
    )
    ON CONFLICT (name) DO UPDATE SET
      markdown_url = EXCLUDED.markdown_url,
      updated_at   = NOW()
  `;
}

/** The ingestion finished. `uploads` is the record from here on. */
export async function clearIngestionRun(fileName: string): Promise<void> {
  await sql`DELETE FROM ingestion_runs WHERE name = ${normalizeName(fileName)}`;
}

/**
 * The work list: every claimed document that has no `uploads` row.
 *
 * The `NOT EXISTS` is not redundant with `clearIngestionRun`. That delete runs
 * after the `uploads` insert and is deliberately best-effort, so a row can
 * outlive the document it tracked. `uploads` is the authority on what finished;
 * this query defers to it rather than to the delete having landed.
 */
export async function listIncompleteIngestions(): Promise<IncompleteIngestion[]> {
  const rows = (await sql`
    SELECT r.display_name, r.size_bytes, r.blob_url, r.blob_download_url, r.blob_path,
           r.markdown_url, r.run_id, r.started_at, r.updated_at
    FROM ingestion_runs r
    WHERE NOT EXISTS (
      SELECT 1 FROM uploads u WHERE LOWER(TRIM(u.name)) = r.name
    )
    ORDER BY r.updated_at DESC
  `) as IngestionRunRow[];
  return rows.map(toIngestion);
}

export async function getIncompleteIngestion(
  fileName: string
): Promise<IncompleteIngestion | null> {
  const rows = (await sql`
    SELECT display_name, size_bytes, blob_url, blob_download_url, blob_path,
           markdown_url, run_id, started_at, updated_at
    FROM ingestion_runs
    WHERE name = ${normalizeName(fileName)}
  `) as IngestionRunRow[];
  return rows[0] ? toIngestion(rows[0]) : null;
}

/** The shape `resumeIngest` expects, or null if this row has no Markdown yet. */
export function toResumePoint(ingestion: IncompleteIngestion): ResumePoint | null {
  if (!ingestion.markdownUrl) return null;
  return {
    fileName: ingestion.fileName,
    sizeBytes: ingestion.sizeBytes,
    blob: ingestion.blob,
    markdownUrl: ingestion.markdownUrl,
  };
}
