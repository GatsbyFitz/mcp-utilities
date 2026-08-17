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