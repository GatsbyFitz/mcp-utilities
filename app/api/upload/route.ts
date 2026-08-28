import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { start } from "workflow/api";
import { sql } from "@/lib/db";
import { ingestPdf } from "./workflow";

// Documents are identified by file name, not by the uploads row id: chunk IDs
// are `${fileName}-${index}`, vector metadata carries `source = fileName`, and
// graph edges carry `sourceDoc = fileName`. Two documents sharing a name
// overwrite each other's chunks and edges, and deleting either one wipes both.
// So a duplicate name is rejected rather than ingested.
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const files = (await req.formData()).getAll("files") as File[];

  let existingNames: Set<string>;
  try {
    const candidates = files.map((file) => normalizeName(file.name));
    const rows = candidates.length
      ? await sql`
          SELECT name FROM uploads
          WHERE LOWER(TRIM(name)) = ANY(${candidates}::text[])
        `
      : [];
    existingNames = new Set(rows.map((row) => normalizeName(row.name)));
  } catch (error) {
    console.error("[upload] duplicate check failed:", error);
    // Fail closed. Ingesting a duplicate corrupts the existing document's
    // chunks and graph edges, which is worse than asking for a retry.
    return NextResponse.json(
      { success: false, error: "Could not verify existing documents; nothing was uploaded" },
      { status: 500 }
    );
  }

  // `seen` also catches the same name appearing twice within this one batch,
  // which no database lookup can see.
  const seen = new Set<string>();
  const accepted: File[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const key = normalizeName(file.name);
    if (existingNames.has(key) || seen.has(key)) {
      skipped.push(file.name);
      continue;
    }
    seen.add(key);
    accepted.push(file);
  }

  // The run ID is the only handle on an in-flight ingestion — nothing is
  // written to Postgres until `recordUpload`, the last step. Hand it back so
  // the client can poll GET /api/uploadStatus for per-step progress.
  const runs = await Promise.all(
    accepted.map(async (file) => {
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

  return NextResponse.json({
    success: true,
    fileCount: accepted.length,
    runs,
    skipped,
  });
}
