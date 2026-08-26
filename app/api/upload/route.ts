import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { start } from "workflow/api";
import { ingestPdf } from "./workflow";

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const files = (await req.formData()).getAll("files") as File[];

  // The run ID is the only handle on an in-flight ingestion — nothing is
  // written to Postgres until `recordUpload`, the last step. Hand it back so
  // the client can poll GET /api/uploadStatus for per-step progress.
  const runs = await Promise.all(
    files.map(async (file) => {
      const run = await start(ingestPdf, [
        {
          fileName: file.name,
          sizeBytes: file.size,
          data: new Uint8Array(await file.arrayBuffer()),
        },
      ]);
      return { fileName: file.name, runId: run.runId };
    })
  );

  return NextResponse.json({ success: true, fileCount: files.length, runs });
}