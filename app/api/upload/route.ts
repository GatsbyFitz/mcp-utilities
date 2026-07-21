import { NextRequest, NextResponse } from "next/server";
import { start } from "workflow/api";
import { ingestPdf } from "./workflow";

export async function POST(req: NextRequest) {
  const files = (await req.formData()).getAll("files") as File[];

  await Promise.all(
    files.map(async (file) =>
      start(ingestPdf, [
        {
          fileName: file.name,
          sizeBytes: file.size,
          data: new Uint8Array(await file.arrayBuffer()),
        },
      ])
    )
  );

  return NextResponse.json({ success: true, fileCount: files.length });
}