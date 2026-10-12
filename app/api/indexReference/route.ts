import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { embed } from "ai";
import { vectorIndex } from "@/lib/vector";
import { sparseVector } from "@/lib/sparse";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import {
  MAX_REFERENCE_KEY_TERMS,
  MAX_REFERENCE_SUMMARY,
  MISSING_REFERENCES_MESSAGE,
  REFERENCE_KIND,
  descriptorText,
  isDuplicateReferenceUrl,
  isMissingReferenceTable,
  nameFromUrl,
  normalizeReferenceName,
  referenceId,
  referenceNameProblem,
  referenceProblem,
} from "@/lib/references";
import {
  deleteReference,
  listReferences,
  markReferenceIndexed,
  upsertReference,
} from "@/lib/referenceStore";

/**
 * Reference sources — URLs the index points at but never holds.
 *
 * Submitted the way a PDF is: the browser posts a small JSON manifest and the
 * server does the rest. The difference is that no bytes are transferred and
 * nothing is fetched — the descriptor is supplied, not scraped.
 *
 * That is deliberate rather than lazy. This server often cannot reach the
 * pages worth referencing: AEMO's developer portal renders client-side and is
 * not resolvable from every network, so a descriptor built by fetching would
 * describe an empty shell while looking perfectly indexed. Whoever submits the
 * URL has already read the page; they are the better source.
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
    // Row first, vector second, `indexed_at` last. If the embedding fails the
    // row survives as unindexed, which is visible and re-runnable; the other
    // order would leave a vector pointing at a reference that does not exist.
    await upsertReference({ name, url, title, summary, keyTerms });

    const text = descriptorText({ title, summary, keyTerms });
    const { embedding } = await embed({
      model: EMBEDDING_MODEL,
      value: `title: ${title} | text: ${text}`,
      providerOptions: {
        google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: "RETRIEVAL_DOCUMENT" },
      },
    });

    await vectorIndex.upsert([
      {
        id: referenceId(name),
        vector: embedding,
        // The index is hybrid: a dense-only upsert is rejected outright and
        // nothing is written. Unprefixed text, as every other writer uses.
        sparseVector: sparseVector(text),
        metadata: {
          // Mirrors a chunk's shape so a citation needs no special case, even
          // though a reference carries no page.
          text: summary,
          title,
          source: name,
          blobUrl: url,
          pageStart: null,
          pageEnd: null,
          kind: REFERENCE_KIND,
          url,
          keyTerms,
        },
      },
    ]);

    await markReferenceIndexed(name);

    return NextResponse.json({ success: true, name, url, title });
  } catch (error) {
    if (isMissingReferenceTable(error)) {
      return NextResponse.json(
        { success: false, error: MISSING_REFERENCES_MESSAGE },
        { status: 503 }
      );
    }
    if (isDuplicateReferenceUrl(error)) {
      // One page, one entry. Two would split the matches between them, so the
      // right move is to edit the existing one — say so rather than failing.
      return NextResponse.json(
        {
          success: false,
          error: `${url} is already referenced under a different name. Remove that entry, or resubmit under the same name to update it.`,
        },
        { status: 409 }
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
