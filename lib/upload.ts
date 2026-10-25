import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// The shared contract between the browser, the token route that authorises an
// upload, and the route that starts ingestion for it.
//
// File bytes never pass through a route handler: a Vercel function caps its
// request body at 4.5 MB, which a regulatory PDF exceeds routinely. The browser
// uploads straight to Blob storage instead. See .claude/conventions/file-uploads.md.
// ---------------------------------------------------------------------------

export const ALLOWED_UPLOAD_CONTENT_TYPES = ["application/pdf"];

/**
 * Spreadsheets, for the AER schedule path — kept separate from the PDF list
 * above rather than merged into it.
 *
 * The PDF list gates the token route *and* `lib/fetchDocument`, so widening it
 * would let a workbook through the document pipeline, where it would fail deep
 * inside `createMarkdown` instead of being refused at the door. Each caller
 * names the list it means.
 *
 * `.xlsm` is here because the AER actually ships it: Q3 2024-25 was published
 * macro-enabled while neighbouring quarters were `.xlsx`.
 */
export const ALLOWED_SPREADSHEET_CONTENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
];

/** Blob pathname for an uploaded spreadsheet, kept out of `uploads/`. */
export function schedulePathname(fileName: string): string {
  return `schedules/${uuidv4()}-${fileName}`;
}

/**
 * Ceiling the issued upload token will authorise. Not a platform limit —
 * Blob itself handles far larger with `multipart` — just a sanity bound so a
 * mis-selected file can't consume the store.
 */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/**
 * Documents are identified by file name, not by the uploads row id: chunk IDs
 * are `${fileName}-${index}`, vector metadata carries `source = fileName`, and
 * graph edges carry `sourceDoc = fileName`. Two documents sharing a name
 * overwrite each other's chunks and edges, and deleting either one wipes both.
 * Comparison is case-insensitive and ignores surrounding whitespace.
 */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Blob pathname for an uploaded PDF. The uuid keeps two uploads of the same
 * name from colliding in the store; the `uploads` table is what enforces
 * uniqueness at the document level.
 */
export function uploadPathname(fileName: string): string {
  return `uploads/${uuidv4()}-${fileName}`;
}

/** One finished client upload, as handed to POST /api/upload to be ingested. */
export interface UploadedFile {
  fileName: string;
  sizeBytes: number;
  url: string;
  downloadUrl: string;
  pathname: string;
}
