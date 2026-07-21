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

export async function recordUpload(input: IngestInput, blob: BlobInfo, chunkCount: number) {
  "use step";

  await sql`
    INSERT INTO uploads (id, name, chunks, size_bytes, uploaded_at, blob_url, blob_download_url, blob_path)
    VALUES (
      ${uuidv4()}, ${input.fileName}, ${chunkCount}, ${input.sizeBytes},
      NOW(), ${blob.url}, ${blob.downloadUrl}, ${blob.pathname}
    )
  `;
}

 