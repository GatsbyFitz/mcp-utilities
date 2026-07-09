import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { v4 as uuidv4 } from "uuid";
import PDFParser from "pdf2json";
import { vectorIndex } from "@/lib/vector";
import { embedMany } from "ai";

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

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const text = await parsePdf(buffer);
  const chunks = chunkText(text);

  const { embeddings } = await embedMany({
  model: 'google/gemini-embedding-2',
  values: chunks,
  providerOptions:
  {
    google: {
      outputDimensionality: 1536,
    }
    
  }
});

  const vectors = embeddings.map((embedding, i) => ({
    id: `${file.name}-${i}`,
    vector: embedding,
    metadata: { text: chunks[i], source: file.name, chunkIndex: i },
  }));

  await vectorIndex.upsert(vectors);

  return NextResponse.json({ success: true, chunks: vectors.length });
}