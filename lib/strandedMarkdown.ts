import type { BlobInfo } from "@/app/api/upload/steps/recordUpload";

// ---------------------------------------------------------------------------
// Markdown in Blob that no finished document accounts for
// ---------------------------------------------------------------------------
// The PDF→Markdown parse is the single most expensive artifact in the pipeline,
// and it is written to Blob before any of the steps that actually tend to fail.
// So a corpus accumulates Markdown for documents that never made it into
// `uploads`: runs that failed at embedding, at graph extraction, or that were
// simply lost when the tab that held their run id was refreshed.
//
// `ingestion_runs` is the durable record going forward (see lib/ingestionRuns.ts),
// but it only knows about runs started since it existed. Blob knows about all of
// them, because both halves of a run leave a named artifact behind:
// `uploadMarkdown` writes `markdown/<uuid>-<file name>.md` and the browser
// writes `uploads/<uuid>-<file name>`. Pairing those two by file name and
// subtracting what is already in `uploads` reconstructs the list, retroactively
// and without a migration.
//
// This is a *suggestion* pass, not a source of truth: it says what looks
// finishable, and finishing one is what creates its `ingestion_runs` row.

/** `markdown/<uuid>-Report v2.pdf.md` → `Report v2.pdf` */
export function fileNameFromMarkdownPath(pathname: string): string | null {
  const match = pathname.match(/^markdown\/[0-9a-fA-F-]{36}-(.+)\.md$/);
  return match ? match[1] : null;
}

/** `uploads/<uuid>-Report v2.pdf` → `Report v2.pdf` */
export function fileNameFromUploadPath(pathname: string): string | null {
  const match = pathname.match(/^uploads\/[0-9a-fA-F-]{36}-(.+)$/);
  return match ? match[1] : null;
}

/** The subset of a `@vercel/blob` list entry this pairing needs. */
export interface BlobRef {
  url: string;
  downloadUrl: string;
  pathname: string;
  size: number;
  uploadedAt: string;
}

export interface StrandedMarkdown {
  fileName: string;
  markdownUrl: string;
  /** When the Markdown was written — i.e. roughly when the run stopped. */
  markdownAt: string;
  markdownBytes: number;
  sizeBytes: number;
  blob: BlobInfo;
  /** True when `ingestion_runs` already covers this, so it is not news. */
  tracked: boolean;
}

/**
 * Pairs orphaned Markdown with the PDF it came from.
 *
 * Excludes anything already in `uploads`: that document finished, and its
 * Markdown is not stranded but simply persisted for re-embedding. Excludes
 * Markdown with no matching PDF too — `resumeIngest` needs the original file
 * for figure extraction and for the blob URL it records against citations, so
 * offering a restart that cannot run would be worse than not listing it.
 *
 * Where one file name has several Markdown blobs — a run that reached the parse
 * more than once — the newest wins, since older ones are supersedeed.
 */
export function findStrandedMarkdown(
  markdownBlobs: BlobRef[],
  pdfBlobs: BlobRef[],
  ingestedNames: Set<string>,
  trackedNames: Set<string> = new Set()
): StrandedMarkdown[] {
  const pdfsByName = new Map<string, BlobRef>();
  for (const blob of pdfBlobs) {
    const name = fileNameFromUploadPath(blob.pathname);
    if (!name) continue;
    const existing = pdfsByName.get(name);
    if (!existing || existing.uploadedAt < blob.uploadedAt) pdfsByName.set(name, blob);
  }

  const newestByName = new Map<string, BlobRef>();
  for (const blob of markdownBlobs) {
    const name = fileNameFromMarkdownPath(blob.pathname);
    if (!name) continue;
    if (ingestedNames.has(normalize(name))) continue;
    const existing = newestByName.get(name);
    if (!existing || existing.uploadedAt < blob.uploadedAt) newestByName.set(name, blob);
  }

  return [...newestByName.entries()]
    .flatMap<StrandedMarkdown>(([name, markdown]) => {
      const pdf = pdfsByName.get(name);
      if (!pdf) return [];
      return [
        {
          fileName: name,
          markdownUrl: markdown.url,
          markdownAt: markdown.uploadedAt,
          markdownBytes: markdown.size,
          sizeBytes: pdf.size,
          blob: { url: pdf.url, downloadUrl: pdf.downloadUrl, pathname: pdf.pathname },
          tracked: trackedNames.has(normalize(name)),
        },
      ];
    })
    .sort((a, b) => b.markdownAt.localeCompare(a.markdownAt));
}

/** Matches the comparison `uploads` is checked with elsewhere. */
function normalize(name: string): string {
  return name.trim().toLowerCase();
}
