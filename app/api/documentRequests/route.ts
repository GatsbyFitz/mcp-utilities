import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { start } from "workflow/api";
import { sql } from "@/lib/db";
import { normalizeName } from "@/lib/upload";
import { DocumentFetchError, downloadPdfToBlob, fileNameFromUrl } from "@/lib/fetchDocument";
import type { DocumentRequest } from "@/lib/documentRequests";
import { ingestPdf } from "../upload/workflow";

/**
 * The review queue behind the MCP `request_document` tool.
 *
 * GET  — every request, pending first.
 * POST — `{ id, action: "approve" | "reject", url?, fileName? }`.
 *
 * Approval is the only thing that ever fetches a URL. The tool that creates a
 * request is unauthenticated, so until a signed-in operator presses approve
 * the URL is a string in a table and nothing more.
 */

/** `document_requests` is provisioned by hand, like `uploads`. Say so clearly. */
function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /relation .*document_requests.* does not exist/i.test(message);
}

const MISSING_TABLE_MESSAGE =
  "The document_requests table does not exist yet — run db/document_requests.sql against the database.";

function toDocumentRequest(row: Record<string, any>): DocumentRequest {
  return {
    id: row.id,
    title: row.title,
    reason: row.reason ?? null,
    sourceUrl: row.source_url ?? null,
    requestedBy: row.requested_by ?? null,
    status: row.status,
    statusDetail: row.status_detail ?? null,
    runId: row.run_id ?? null,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rows = await sql`
      SELECT id, title, reason, source_url, requested_by, status, status_detail,
             run_id, requested_at, resolved_at
      FROM document_requests
      ORDER BY (status = 'pending') DESC, requested_at DESC
    `;
    return NextResponse.json({ success: true, items: rows.map(toDocumentRequest) });
  } catch (error) {
    if (isMissingTable(error)) {
      // Not an error for a deployment that has never used the tool — return an
      // empty queue and say what to run, rather than a red banner.
      return NextResponse.json({ success: true, items: [], notice: MISSING_TABLE_MESSAGE });
    }
    console.error("[documentRequests] GET failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to read document requests" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id, action, url, fileName } = (await req.json().catch(() => ({}))) as {
    id?: string;
    action?: string;
    url?: string;
    fileName?: string;
  };

  if (!id || (action !== "approve" && action !== "reject")) {
    return NextResponse.json(
      { success: false, error: 'Supply an id and action of "approve" or "reject"' },
      { status: 400 }
    );
  }

  try {
    const rows = await sql`
      SELECT id, title, source_url, status FROM document_requests WHERE id = ${id}
    `;
    const request = rows[0];
    if (!request) {
      return NextResponse.json({ success: false, error: "No such request" }, { status: 404 });
    }
    if (request.status !== "pending") {
      return NextResponse.json(
        { success: false, error: `That request is already ${request.status}` },
        { status: 409 }
      );
    }

    if (action === "reject") {
      await sql`
        UPDATE document_requests
        SET status = 'rejected', resolved_at = NOW(), status_detail = NULL
        WHERE id = ${id}
      `;
      return NextResponse.json({ success: true, id, status: "rejected" });
    }

    // The operator's URL wins over the model's suggestion, which was only the
    // default they saw before pressing approve.
    const target = (url ?? request.source_url ?? "").trim();
    if (!target) {
      return NextResponse.json(
        { success: false, error: "This request has no URL — supply one to approve it" },
        { status: 400 }
      );
    }

    const name = (fileName ?? "").trim() || fileNameFromUrl(target, request.title);

    // Same authoritative check POST /api/upload makes, for the same reason:
    // two documents sharing a name overwrite each other's chunks and edges.
    const clash = await sql`
      SELECT name FROM uploads WHERE LOWER(TRIM(name)) = ${normalizeName(name)} LIMIT 1
    `;
    if (clash.length > 0) {
      return NextResponse.json(
        { success: false, error: `"${clash[0].name}" is already in the knowledge base` },
        { status: 409 }
      );
    }

    let uploaded;
    try {
      uploaded = await downloadPdfToBlob(target, name);
    } catch (error) {
      // A refusal names what was wrong with the source and is safe to show;
      // anything else is logged and reported generically.
      const detail =
        error instanceof DocumentFetchError ? error.message : "Could not fetch the document";
      if (!(error instanceof DocumentFetchError)) {
        console.error("[documentRequests] fetch failed:", error);
      }
      await sql`
        UPDATE document_requests SET status = 'failed', status_detail = ${detail} WHERE id = ${id}
      `;
      return NextResponse.json({ success: false, error: detail }, { status: 400 });
    }

    const run = await start(ingestPdf, [
      {
        fileName: uploaded.fileName,
        sizeBytes: uploaded.sizeBytes,
        blob: {
          url: uploaded.url,
          downloadUrl: uploaded.downloadUrl,
          pathname: uploaded.pathname,
        },
      },
    ]);

    await sql`
      UPDATE document_requests
      SET status = 'approved', run_id = ${run.runId}, resolved_at = NOW(),
          source_url = ${target}, status_detail = NULL
      WHERE id = ${id}
    `;

    // Shaped like POST /api/upload's response so the page can hand it to the
    // same progress tracker it uses for a browser upload.
    return NextResponse.json({
      success: true,
      id,
      status: "approved",
      runs: [{ fileName: uploaded.fileName, runId: run.runId }],
    });
  } catch (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({ success: false, error: MISSING_TABLE_MESSAGE }, { status: 500 });
    }
    console.error("[documentRequests] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to resolve the document request" },
      { status: 500 }
    );
  }
}
