import { sql } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Step 4: Record the upload in Postgres
// ---------------------------------------------------------------------------
export interface IngestInput {
  fileName: string;
  sizeBytes: number;
  data: Uint8Array;
}

export interface BlobInfo {
  url: string;
  downloadUrl: string;
  pathname: string;
}

// Takes the name and size directly rather than the whole IngestInput: the PDF
// bytes on that object are unused here, and a step's arguments are serialized
// into the workflow journal, so passing them would persist the entire document
// a second time for a step that only writes a row.
export async function recordUpload(
  fileName: string,
  sizeBytes: number,
  blob: BlobInfo,
  chunkCount: number,
  markdownUrl: string
) {
  "use step";

  await sql`
    INSERT INTO uploads (id, name, chunks, size_bytes, uploaded_at, blob_url, blob_download_url, blob_path, markdown_url)
    VALUES (
      ${uuidv4()}, ${fileName}, ${chunkCount}, ${sizeBytes},
      NOW(), ${blob.url}, ${blob.downloadUrl}, ${blob.pathname}, ${markdownUrl}
    )
  `;
}

// Re-embedding reuses the existing uploads row (same blob, same file) rather
// than inserting a new one, since recordUpload has no upsert path. markdownUrl
// is only ever set here for a legacy row that had none yet (self-heal); a
// row that already had one keeps pointing at the same persisted markdown.
export async function updateUploadAfterReembed(
  id: string,
  chunkCount: number,
  markdownUrl: string
) {
  "use step";

  await sql`UPDATE uploads SET chunks = ${chunkCount}, markdown_url = ${markdownUrl} WHERE id = ${id}`;
}

 