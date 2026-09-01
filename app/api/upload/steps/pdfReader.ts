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
- Before the content of every page after the first, emit a line on its own reading exactly:
  ----------------Page (N) Break----------------
  where N is that page's printed page number, counting the first page as 1. Do not emit one before page 1.
- Output ONLY the Markdown. No preamble, no code fences.`;

export async function createMarkdown(blobUrl: string): Promise<string> {
  "use step";

  const res = await fetch(blobUrl);
  if (!res.ok) throw new FatalError(`Blob fetch failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const { text } = await generateText({
    model: "google/gemini-3.5-flash-lite",
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

// Re-embedding prefers this over createMarkdown when a document already has
// a persisted markdown_url, skipping the Gemini parse entirely.
export async function fetchMarkdown(markdownUrl: string): Promise<string> {
  "use step";

  const res = await fetch(markdownUrl);
  if (!res.ok) throw new FatalError(`Markdown blob fetch failed: ${res.status}`);
  return res.text();
}