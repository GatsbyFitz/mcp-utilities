import { FatalError } from "workflow";
import { generateText } from "ai";
import {
  MARKDOWN_MAX_OUTPUT_TOKENS,
  isAnthropicModel,
  markdownModelFor,
} from "@/lib/models";

// ---------------------------------------------------------------------------
// Step 2: Convert PDF to Markdown
// ---------------------------------------------------------------------------
// The model id lives in lib/models.ts, which explains why this call — alone
// among the model calls here — is the one worth spending on, and why the
// extraction steps stayed on Gemini.

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

  // Which model can take this payload at all — see MAX_CLAUDE_PDF_BYTES.
  const { model, reason } = markdownModelFor(buffer.byteLength);
  if (reason === "oversize") {
    console.warn(
      `[createMarkdown] ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB exceeds ` +
        `the Anthropic request cap; parsing with ${model} instead.`
    );
  }

  const { text, finishReason, usage } = await generateText({
    model,
    // Anthropic requires max_tokens and defaults it low; Gemini has worked
    // without it and caps lower, so only the path that needs it gets it.
    ...(isAnthropicModel(model) ? { maxOutputTokens: MARKDOWN_MAX_OUTPUT_TOKENS } : {}),
    messages: [
      {
        role: "user",
        content: [
          // The PDF before the prompt, as the provider's own guidance asks.
          { type: "file", data: buffer, mediaType: "application/pdf" },
          { type: "text", text: PARSE_PROMPT },
        ],
      },
    ],
  });

  if (!text.trim()) throw new Error(`${model} returned empty parse result`); // retryable

  // A truncated parse is the one failure here that hides itself. This Markdown
  // becomes the document of record — chunks, graph and figure markers are all
  // derived from it and nothing re-opens the PDF to check — so everything past
  // the cut is simply absent, with no error and no gap anyone can see. It is
  // the `syncCompliance` case rather than the invalid-Mermaid case: a half
  // document answers questions wrongly, where a missing one answers none.
  //
  // Fatal, not retryable: a document longer than the model's maximum output is
  // a bad input, and a retry truncates it again.
  if (finishReason === "length") {
    throw new FatalError(
      `Parse hit the output limit of ${model} after ${text.length} characters ` +
        `(${usage?.outputTokens ?? "?"} output tokens). The Markdown is cut off mid-document, ` +
        `and storing it would silently drop every chunk, page break and [Figure:] marker past ` +
        `the cut. Split the PDF and ingest the parts.`
    );
  }

  console.log(
    `[createMarkdown] ${model} produced ${text.length} chars ` +
      `(${usage?.inputTokens ?? "?"} in, ${usage?.outputTokens ?? "?"} out)`
  );
  return text;
}

// Re-embedding prefers this over createMarkdown when a document already has
// a persisted markdown_url, skipping the parse entirely.
export async function fetchMarkdown(markdownUrl: string): Promise<string> {
  "use step";

  const res = await fetch(markdownUrl);
  if (!res.ok) throw new FatalError(`Markdown blob fetch failed: ${res.status}`);
  return res.text();
}
