import { v4 as uuidv4 } from "uuid";
import { put } from "@vercel/blob";
import { BlobInfo } from "./recordUpload";
// ---------------------------------------------------------------------------
// Step 1: Upload PDF to Vercel Blob
// ---------------------------------------------------------------------------

export async function uploadPdf(fileName: string, data: Uint8Array): Promise<BlobInfo> {
  "use step";

  const blob = await put(`uploads/${uuidv4()}-${fileName}`, Buffer.from(data), {
    access: "public",
    addRandomSuffix: false,
  });

  return { url: blob.url, downloadUrl: blob.downloadUrl, pathname: blob.pathname };
}