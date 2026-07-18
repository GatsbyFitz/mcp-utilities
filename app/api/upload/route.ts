import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { v4 as uuidv4 } from "uuid";
import PDFParser from "pdf2json";
import { vectorIndex } from "@/lib/vector";
import { sql } from "@/lib/db";
import { embedMany } from "ai";
import { put } from "@vercel/blob";

function chunkText(text: string, size = 500): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(" "));
  }
  return chunks;
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const tempPath = `/tmp/${uuidv4()}.pdf`;
  await fs.writeFile(tempPath, buffer);

  return new Promise((resolve, reject) => {
    const pdfParser = new (PDFParser as any)(null, 1);
    pdfParser.on("pdfParser_dataReady", () => {
      resolve(pdfParser.getRawTextContent());
    });
    pdfParser.on("pdfParser_dataError", (err: { parserError: Error }) => {
      reject(err.parserError);
    });
    pdfParser.loadPDF(tempPath);
  });
}

async function uploadToVercelBlob(file: File, buffer: Buffer): Promise<any> {
  const blobPath = `uploads/${uuidv4()}-${file.name}`;
  const blob = await put(blobPath, buffer, {
    access: "public",
    addRandomSuffix: false,
  });
  
  return blob;
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

        const blob = await uploadToVercelBlob(file, buffer);

        const { embeddings } = await embedMany({
          model: "google/gemini-embedding-2",
          values: chunks,
          providerOptions: {
            google: {
              outputDimensionality: 1536,
            },
          },
        });

        const vectors = embeddings.map((embedding, i) => ({
          id: `${file.name}-${i}`,
          vector: embedding,
          metadata: { text: chunks[i], source: file.name, chunkIndex: i, blobUrl: blob.url, blobDownloadUrl: blob.downloadUrl, blobPath: blob.pathname },
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