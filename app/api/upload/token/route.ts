import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { sql } from "@/lib/db";
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  normalizeName,
} from "@/lib/upload";

/** A reason the caller should see, as opposed to an internal failure. */
class UploadRejected extends Error {}

/**
 * POST /api/upload/token — issues the short-lived client token the browser
 * needs to upload a PDF straight to Blob storage.
 *
 * This is where an upload is authorised, so it is also where an upload is
 * refused: a duplicate name is rejected here, before a single byte is sent,
 * rather than after the whole file has been transferred.
 */
export async function POST(req: NextRequest) {
  const session = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!session) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        const fileName = readFileName(clientPayload);
        if (!fileName) {
          throw new UploadRejected("Upload is missing a file name");
        }
        if (await documentExists(fileName)) {
          throw new UploadRejected(
            `"${fileName}" is already in the knowledge base`
          );
        }

        return {
          allowedContentTypes: ALLOWED_UPLOAD_CONTENT_TYPES,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          // The pathname already carries a uuid from uploadPathname().
          addRandomSuffix: false,
        };
      },
      // onUploadCompleted is deliberately omitted. It is a Blob-to-server
      // callback that cannot reach localhost, so depending on it to start
      // ingestion would mean local development needed a tunnel. The browser
      // POSTs to /api/upload once its uploads finish instead.
    });

    return NextResponse.json(result);
  } catch (error) {
    const rejection = rejectionMessage(error);
    if (rejection) {
      return NextResponse.json(
        { success: false, error: rejection },
        { status: 409 }
      );
    }

    console.error("[uploadToken] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Could not authorise the upload" },
      { status: 500 }
    );
  }
}

function readFileName(clientPayload: string | null): string | null {
  if (!clientPayload) return null;
  try {
    const parsed = JSON.parse(clientPayload) as { fileName?: unknown };
    return typeof parsed.fileName === "string" && parsed.fileName.trim()
      ? parsed.fileName
      : null;
  } catch {
    return null;
  }
}

async function documentExists(fileName: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM uploads
    WHERE LOWER(TRIM(name)) = ${normalizeName(fileName)}
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * handleUpload may surface a throw from onBeforeGenerateToken directly or
 * wrapped as a cause, so check both before treating it as internal.
 */
function rejectionMessage(error: unknown): string | null {
  if (error instanceof UploadRejected) return error.message;
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof UploadRejected) return cause.message;
  return null;
}
