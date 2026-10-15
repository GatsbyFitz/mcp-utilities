// ---------------------------------------------------------------------------
// One definition of every generative model, as lib/embedding.ts is for the
// embedding one.
//
// Routed through AI Gateway, like everything else here, so spend and traces
// stay in one place and switching provider is a credential in the gateway
// rather than a code change. An Anthropic key added there as a BYOK
// credential is what bills the `anthropic/…` ids below; AI_GATEWAY_API_KEY
// stays exactly as it is.
// ---------------------------------------------------------------------------

/**
 * PDF → Markdown. The one model call that runs **once per document**.
 *
 * That is why it is the call worth spending on. Every other model call in the
 * pipeline is per chunk or per figure — `contextualizeChunks` alone is ~80× the
 * volume of this one — so a stronger model here costs a document, not a
 * document times eighty.
 *
 * And it is the call most worth getting right, because the whole figure and
 * process pipeline is *gated* on its output rather than fed by it:
 * `figurePagesFrom` finds pages to rasterise by scanning this Markdown for
 * `[Figure:` markers, so a parse that omits them yields zero figures, zero
 * processes, and no error — the same PDF parsed twice has produced 60 figures
 * and none. The marker instruction in `PARSE_PROMPT` is the load-bearing one,
 * and instruction-following on it is what this model is chosen for.
 *
 * Overridable by env so the exact gateway slug can be corrected, or the whole
 * step pointed back at Gemini, without a code change.
 */
export const MARKDOWN_MODEL = process.env.MARKDOWN_MODEL || "anthropic/claude-sonnet-5-5";

/**
 * Everything downstream of the parse: contextualisation, graph, figures,
 * processes. Deliberately still Gemini, for three separate reasons:
 *
 *  - `contextualizeChunks` sends the whole document as the prefix of every
 *    call and depends on Gemini's *implicit* prefix caching to not pay for it
 *    ~80 times. Anthropic caches too, but only against an explicit
 *    `cache_control` breakpoint — moving this model without adding one turns
 *    the cheapest step in the pipeline into the most expensive.
 *  - `extractFigures` returns normalised boxes in Gemini's own
 *    `[ymin, xmin, ymax, xmax]` convention, and a mis-ordered box still
 *    validates and still produces a plausible PNG (see README). Changing that
 *    model needs its own verification against rendered crops, not a swap.
 *  - They are the volume. The parse is one call; these are hundreds.
 */
export const EXTRACTION_MODEL = "google/gemini-3.5-flash-lite";

/** Used when a PDF is too large to send to an `anthropic/…` model. */
export const MARKDOWN_FALLBACK_MODEL = EXTRACTION_MODEL;

/**
 * Anthropic caps the **whole request** at 32 MB, and a PDF is base64-encoded
 * into it, inflating it by 4/3. 23 MB of PDF is ~31 MB encoded, which leaves
 * room for the prompt.
 *
 * This matters because `MAX_UPLOAD_BYTES` is 500 MB: a document this app
 * accepts today can be 20× what Anthropic will take. Gemini bills PDFs by
 * page rather than by payload and has no comparable ceiling, so an oversize
 * document falls back to it rather than failing — a PDF that ingested
 * yesterday must not stop ingesting because the model changed.
 */
export const MAX_CLAUDE_PDF_BYTES = 23 * 1024 * 1024;

/**
 * The Anthropic API requires `max_tokens`; it has no "as much as it takes".
 * Left unset, the default is small enough to cut a document off mid-sentence,
 * so the parse always names it, and names the model's documented maximum —
 * then a truncated parse means the document really is too long, not that we
 * picked a number.
 *
 * Not sent on the Gemini path, which has worked without it and caps lower.
 */
export const MARKDOWN_MAX_OUTPUT_TOKENS = 128_000;

export function isAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/");
}

export interface MarkdownModelChoice {
  model: string;
  /** `oversize` means the preferred model could not take the payload. */
  reason: "preferred" | "oversize";
}

/**
 * Which model parses a PDF of this size.
 *
 * The cap is Anthropic's, so it is applied only when the preferred model is
 * Anthropic's. Pointing `MARKDOWN_MODEL` back at Gemini must not inherit a
 * limit that provider does not have.
 */
export function markdownModelFor(bytes: number, preferred = MARKDOWN_MODEL): MarkdownModelChoice {
  if (isAnthropicModel(preferred) && bytes > MAX_CLAUDE_PDF_BYTES) {
    return { model: MARKDOWN_FALLBACK_MODEL, reason: "oversize" };
  }
  return { model: preferred, reason: "preferred" };
}
