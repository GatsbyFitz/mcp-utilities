// ---------------------------------------------------------------------------
// Shaping the `uploads` rows the kb://documents resource returns.
// ---------------------------------------------------------------------------
// Split out of the resource because that file imports `lib/db`, which builds a
// neon client at module load — so anything importing it needs a connection
// string just to be loaded, including a test. The same split as
// lib/compliance.ts vs lib/complianceStore.ts, for the same reason.

/** One `uploads` row, as far as this resource is concerned. */
export interface UploadRow {
  id: string;
  name: string;
  chunks: number;
  size_bytes: number;
  uploaded_at: string | Date;
  blob_url: string | null;
}

/**
 * The rows joined to their index counts.
 *
 * Extracted so the one rule worth pinning is testable without a database:
 * `null` means the index could not be counted, `0` means the document has
 * none. Collapsing them would tell a model "no diagrams here" when the truth
 * is that we could not ask — and the whole reason these fields exist is so a
 * model can decide whether `display_process` is worth calling.
 */
export function documentEntries(
  rows: UploadRow[],
  counts: { figures: Map<string, number>; processes: Map<string, number> } | null
) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    chunks: row.chunks,
    sizeBytes: row.size_bytes,
    uploadedAt: row.uploaded_at,
    blobUrl: row.blob_url ?? null,
    figures: counts ? (counts.figures.get(row.name) ?? 0) : null,
    processes: counts ? (counts.processes.get(row.name) ?? 0) : null,
  }));
}
