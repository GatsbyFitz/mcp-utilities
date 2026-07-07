import { NextRequest, NextResponse } from "next/server";
import { vectorIndex } from "@/lib/vector";
import pdf from "pdf-parse";

const openai = new OpenAI();

function chunkText(text: string, size = 500): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(" "));
  }
  return chunks;
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const { text } = await pdf(buffer);
  const chunks = chunkText(text);

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      const { data } = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: chunk,
      });
      return {
        id: `${file.name}-${i}`,
        vector: data[0].embedding,
        metadata: { text: chunk, source: file.name, chunkIndex: i },
      };
    })
  );

  await vectorIndex.upsert(vectors);

  return NextResponse.json({ success: true, chunks: vectors.length });
}