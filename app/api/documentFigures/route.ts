import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { vectorIndex } from "@/lib/vector";
import { figureIdPrefix, type DocumentFigure } from "@/lib/figures";
import type { ChunkMetadata } from "@/lib/citations";

/**
 * GET /api/documentFigures?name=<file name> — one document's figures.
 *
 * Read from the vector index by id prefix rather than by listing the Blob
 * folder: the blobs are only pixels, while the index also holds the
 * description that was embedded with them and the page each came from, which
 * is what makes the list worth looking at.
 */

const MAX_FIGURES = 200;

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const name = req.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json(
      { success: false, error: "Supply the document name" },
      { status: 400 }
    );
  }

  try {
    const result: { vectors: { id: string | number; metadata?: ChunkMetadata }[] } =
      await vectorIndex.range({
        prefix: figureIdPrefix(name),
        cursor: "",
        limit: MAX_FIGURES,
        includeVectors: false,
        includeMetadata: true,
      });

    const figures: DocumentFigure[] = result.vectors
      .flatMap((vector) => {
        const metadata = vector.metadata;
        // A figure with no stored image is not viewable, and showing a broken
        // frame is worse than omitting it.
        if (!metadata?.imageUrl) return [];
        return [
          {
            id: String(vector.id),
            imageUrl: metadata.imageUrl,
            description: metadata.text ?? "",
            page: metadata.pageStart ?? null,
          },
        ];
      })
      // Page order, then id, so the list reads like the document rather than
      // like whatever order the index happened to return.
      .sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.id.localeCompare(b.id));

    return NextResponse.json({ success: true, figures });
  } catch (error) {
    console.error("[documentFigures] GET failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to read this document's figures" },
      { status: 500 }
    );
  }
}
