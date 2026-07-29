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

export async function recordUpload(
  input: IngestInput,
  blob: BlobInfo,
  chunkCount: number,
  markdownUrl: string
) {
  "use step";

  await sql`
    INSERT INTO uploads (id, name, chunks, size_bytes, uploaded_at, blob_url, blob_download_url, blob_path, markdown_url)
    VALUES (
      ${uuidv4()}, ${input.fileName}, ${chunkCount}, ${input.sizeBytes},
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

 