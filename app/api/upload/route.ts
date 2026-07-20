// Add image management

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { vectorIndex } from "@/lib/vector";
import { sql } from "@/lib/db";
import { embedMany, generateText } from "ai";
import { put } from "@vercel/blob";

const PARSE_PROMPT = `Convert this PDF to clean, well-structured Markdown.

Rules:
- Start with the document's title as a single "# " heading on the first line.
- Preserve the heading hierarchy (##, ###) matching the document's sections.
- Convert tables to Markdown tables.
- Preserve reading order for multi-column layouts.
- Transcribe text exactly as written; do not summarize, paraphrase, or omit content.
- Describe meaningful figures/diagrams briefly in [Figure: ...] brackets.
- Output ONLY the Markdown. No preamble, no code fences.`;

function chunkText(text: string, size = 500): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(" "));
  }
  return chunks;
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const { text } = await generateText({
    model: "google/gemini-3-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data: buffer, mediaType: "application/pdf" },
          { type: "text", text: PARSE_PROMPT },
        ],
      },
    ],
  });
  if (!text.trim()) throw new Error("Gemini returned empty parse result");
  return text;
}

async function uploadToVercelBlob(file: File, buffer: Buffer): Promise<any> {
  const blobPath = `uploads/${uuidv4()}-${file.name}`;
  const blob = await put(blobPath, buffer, {
    access: "public",
    addRandomSuffix: false,
  });
  return blob;
}

function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.(pdf|docx?|txt|md)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Prefer the document's own "# Title" heading; fall back to the filename. */
function extractTitle(markdown: string, filename: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : titleFromFilename(filename);
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const files = formData.getAll("files") as File[];
  if (!files.length) return NextResponse.json({ error: "No files" }, { status: 400 });

  const allVectors = (
    await Promise.all(
      files.map(async (file) => {
        const buffer = Buffer.from(await file.arrayBuffer());
        const text = await parsePdf(buffer);
        const chunks = chunkText(text);
        const title = extractTitle(text, file.name);

        const blob = await uploadToVercelBlob(file, buffer);

        const { embeddings } = await embedMany({
          model: "google/gemini-embedding-2",
          values: chunks.map((chunk) => `title: ${title} | text: ${chunk}`),
          providerOptions: {
            google: {
              outputDimensionality: 1536,
            },
          },
        });

        const vectors = embeddings.map((embedding, i) => ({
          id: `${file.name}-${i}`,
          vector: embedding,
          metadata: {
            text: chunks[i],
            title,
            source: file.name,
            chunkIndex: i,
            blobUrl: blob.url,
            blobDownloadUrl: blob.downloadUrl,
            blobPath: blob.pathname,
          },
        }));

        await sql`
          INSERT INTO uploads (id, name, chunks, size_bytes, uploaded_at, blob_url, blob_download_url, blob_path)
          VALUES (
            ${uuidv4()},
            ${file.name},
            ${chunks.length},
            ${file.size},
            NOW(),
            ${blob.url},
            ${blob.downloadUrl},
            ${blob.pathname}
          )
        `;

        return vectors;
      })
    )
  ).flat();

  await vectorIndex.upsert(allVectors);

  return NextResponse.json({ success: true, chunks: allVectors.length, fileCount: files.length });
}