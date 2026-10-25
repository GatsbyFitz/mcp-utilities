import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { vectorIndex } from "@/lib/vector";
import {
  MAX_REFERENCE_KEY_TERMS,
  MAX_REFERENCE_SUMMARY,
  MISSING_REFERENCES_MESSAGE,
  isMissingReferenceTable,
  nameFromUrl,
  normalizeReferenceName,
  referenceId,
  referenceNameProblem,
  referenceProblem,
} from "@/lib/references";
import { deleteReference, listReferences } from "@/lib/referenceStore";
import { start } from "workflow/api";
import { indexReferencePage } from "./workflow";

/**
 * Reference sources — URLs the index points at but never holds.
 *
 * Submitted the way a PDF is: the browser posts a small JSON manifest and the
 * server does the rest. The difference is that no bytes are transferred and
 * nothing is fetched — the descriptor is supplied, not scraped.
 *
 * That is deliberate rather than lazy, though not for the reason this comment
 * used to give: AEMO's portal is reachable and server-rendered, which was
 * checked. The real reason is that a descriptor states which *questions* a
 * page answers, and no amount of fetching produces that — the page says what
 * it does, while routing needs to know what someone would come looking for.
 * Whoever submits the URL has already read it and knows why they wanted it.
 * See .claude/conventions/data-stores.md.
 */

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json({ success: true, items: await listReferences() });
  } catch (error) {
    if (isMissingReferenceTable(error)) {
      // Degrade rather than abort, as every other optional table here does.
      return NextResponse.json({ success: true, items: [], notice: MISSING_REFERENCES_MESSAGE });
    }
    console.error("[indexReference] GET failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to read the reference list" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    url?: string;
    name?: string;
    title?: string;
    summary?: string;
    keyTerms?: unknown;
  };

  const problem = referenceProblem(body);
  if (problem) {
    return NextResponse.json({ success: false, error: problem }, { status: 400 });
  }

  const url = body.url!.trim();
  const title = body.title!.trim();
  const summary = body.summary!.trim().slice(0, MAX_REFERENCE_SUMMARY);
  const name = normalizeReferenceName(body.name?.trim() || title) || nameFromUrl(url);
  const keyTerms = Array.isArray(body.keyTerms)
    ? body.keyTerms
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, MAX_REFERENCE_KEY_TERMS)
    : [];

  const nameProblem = referenceNameProblem(name);
  if (nameProblem) {
    return NextResponse.json({ success: false, error: nameProblem }, { status: 400 });
  }

  try {
    // A durable run rather than an inline write, so each step retries on its
    // own and the page can track it on the same progress card every other
    // pipeline reports through. The row appears immediately as unindexed; the
    // run makes it searchable.
    const run = await start(indexReferencePage, [{ name, url, title, summary, keyTerms }]);
    return NextResponse.json({
      success: true,
      name,
      url,
      title,
      runs: [{ fileName: title, runId: run.runId }],
    });
  } catch (error) {
    if (isMissingReferenceTable(error)) {
      return NextResponse.json(
        { success: false, error: MISSING_REFERENCES_MESSAGE },
        { status: 503 }
      );
    }
    console.error("[indexReference] POST failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to index the reference" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const name = normalizeReferenceName(req.nextUrl.searchParams.get("name") ?? "");
  if (!name) {
    return NextResponse.json({ success: false, error: "name is required" }, { status: 400 });
  }

  try {
    // Vector first: a row with no vector is invisible to search, which is the
    // safe half-state. A vector with no row would return a reference the list
    // says nothing about.
    await vectorIndex.delete([referenceId(name)]);
    const removed = await deleteReference(name);
    if (!removed) {
      return NextResponse.json({ success: false, error: `No reference "${name}"` }, { status: 404 });
    }
    return NextResponse.json({ success: true, name });
  } catch (error) {
    if (isMissingReferenceTable(error)) {
      return NextResponse.json(
        { success: false, error: MISSING_REFERENCES_MESSAGE },
        { status: 503 }
      );
    }
    console.error("[indexReference] DELETE failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to remove the reference" },
      { status: 500 }
    );
  }
}
