import { FatalError } from "workflow";
import { generateText } from "ai";

// ---------------------------------------------------------------------------
// Step 2: Convert PDF to Markdown with Gemini
// ---------------------------------------------------------------------------

const PARSE_PROMPT = `Convert this PDF to clean, well-structured Markdown.

Rules:
- Start with the document's title as a single "# " heading on the first line.
- Preserve the heading hierarchy (##, ###) matching the document's sections.
- Convert tables to Markdown tables.
- Preserve reading order for multi-column layouts.
- Transcribe text exactly as written; do not summarize, paraphrase, or omit content.
- Describe meaningful figures/diagrams briefly in [Figure: ...] brackets.
- Output ONLY the Markdown. No preamble, no code fences.`;

export async function createMarkdown(blobUrl: string): Promise<string> {
  "use step";

  const res = await fetch(blobUrl);
  if (!res.ok) throw new FatalError(`Blob fetch failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

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

  if (!text.trim()) throw new Error("Gemini returned empty parse result"); // retryable
  return text;
}