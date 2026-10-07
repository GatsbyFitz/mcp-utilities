import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { ALLOWED_SPREADSHEET_CONTENT_TYPES, MAX_UPLOAD_BYTES } from "@/lib/upload";

/**
 * POST /api/ingestSchedule/token — the client token for uploading an AER
 * schedule workbook straight to Blob.
 *
 * Separate from `/api/upload/token` rather than a flag on it, because the two
 * authorise different things. That route refuses a duplicate document name,
 * which is right for the knowledge base and wrong here: the same workbook may
 * legitimately be re-uploaded to correct a quarter, and the ingest replaces
 * that (schedule, period) slice rather than appending to it.
 *
 * The allowlist is the spreadsheet one, not the PDF one. The returned token
 * carries it, and Blob — not the browser — is what enforces it.
 */
export async function POST(req: NextRequest) {
  const session = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_SPREADSHEET_CONTENT_TYPES,
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
        // The pathname already carries a uuid from schedulePathname().
        addRandomSuffix: false,
      }),
      // onUploadCompleted is deliberately omitted, as it is for PDFs: it is a
      // Blob-to-server callback that cannot reach localhost, so depending on
      // it would mean local development needed a tunnel. The browser posts to
      // /api/ingestSchedule once the upload finishes.
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("[ingestSchedule/token] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Could not authorise the upload" },
      { status: 400 }
    );
  }
}
