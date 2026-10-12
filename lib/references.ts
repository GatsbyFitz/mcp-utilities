// ---------------------------------------------------------------------------
// Reference pages: read live, never indexed
// ---------------------------------------------------------------------------
// A second kind of knowledge, with a different failure mode from everything
// else here.
//
// The corpus is regulatory documents: long, stable, asked fuzzy questions, and
// best answered by retrieving the three paragraphs that matter. That is what
// `search_docs` is for, and why those documents are chunked, embedded and
// cited.
//
// API documentation is none of those things. It versions, it is read whole
// rather than in fragments, and — the part that decides it — **stale is its
// failure mode**. An endpoint that moved last quarter reads exactly like one
// that did not, so an indexed copy is a confident lie with a citation attached.
// These are fetched live instead. Slower, uncited, invisible to search, and
// correct.
//
// The list is a constant rather than a table because it has few entries and
// each one is a deliberate decision. Promote it to Postgres when editing it
// without a deploy starts to hurt, not before.

export interface Reference {
  /** The key the tool takes. Stable: it is what a model will have learned. */
  name: string;
  /** Shown to a reader. */
  label: string;
  /** Steers the model on when this is the right thing to open. */
  description: string;
  url: string;
}

export const REFERENCES: readonly Reference[] = [
  {
    name: "aemo-api-docs",
    label: "AEMO Developer Portal — API documentation",
    description:
      "AEMO's REST API catalogue, documented with Swagger: endpoints, parameters " +
      "and schemas for the NEM and WEM market systems. Use for how to *call* an " +
      "AEMO API. For what the market rules require, use search_docs.",
    url: "https://dev.aemo.com.au/api-docs",
  },
];

export function referenceByName(name: string): Reference | undefined {
  const wanted = name.trim().toLowerCase();
  return REFERENCES.find((r) => r.name === wanted);
}

/** The catalogue, for the tool description and for a miss. */
export function renderReferenceList(): string {
  return REFERENCES.map((r) => `- ${r.name} — ${r.label}. ${r.description}`).join("\n");
}

/** Bytes of a reference page read. Docs pages are large; budgets are not. */
export const MAX_REFERENCE_BYTES = 2_000_000;
/** Characters of extracted text returned. Beyond this, the tail is dropped. */
export const MAX_REFERENCE_CHARS = 60_000;

// ---------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------
// Deliberately small and dependency-free. This is not a Markdown converter and
// does not try to be: the job is to get the words, the endpoint paths and the
// code samples out of a documentation page in a form a model can read.

const BLOCK_TAGS = /<\/(p|div|section|article|li|tr|h[1-6]|pre|table|thead|tbody)>/gi;

export function htmlToText(html: string): string {
  return (
    html
      // Script and style content is not page text, and on a docs site it is
      // most of the bytes.
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      // Keep the shape of the document: a block close becomes a line break, so
      // an endpoint table does not collapse into one run-on line.
      .replace(BLOCK_TAGS, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/[ \t ]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trim()
  );
}

/**
 * Whether a fetched page is a JavaScript shell rather than the documentation.
 *
 * The failure this exists to prevent: a single-page app returns 200 with a
 * `<div id="root">` and a bundle, `htmlToText` extracts forty characters of
 * nothing, and the model reports *"the AEMO documentation does not cover
 * that"* — which is indistinguishable from a true answer and worse than an
 * error. So a page whose text is negligible against its own size is called
 * out by name rather than returned as content.
 */
export function looksLikeEmptyShell(html: string, text: string): boolean {
  if (html.length < 500) return false;
  // Documentation prose is a meaningful fraction of its own markup. A shell is
  // mostly script tags, so almost nothing survives extraction.
  return text.length < 400 && text.length / html.length < 0.02;
}

/** What the tool reports when the page cannot be read as documentation. */
export function emptyShellMessage(ref: Reference): string {
  return (
    `${ref.label} returned a page with no readable text — it renders its ` +
    `content in the browser with JavaScript, which a server-side fetch cannot ` +
    `run. This is not "the documentation says nothing": nothing was read. ` +
    `Open ${ref.url} directly, or ingest an exported OpenAPI spec instead.`
  );
}
