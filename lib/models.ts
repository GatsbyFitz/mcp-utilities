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

/**
 * Both providers take the PDF **inline**, base64'd into the request body, so
 * the binding limit is request size — and they do not agree on it:
 *
 *  - Anthropic: 32 MB per request.
 *  - Gemini: 20 MB total for inline data. Google's own guidance above that is
 *    the Files API, which this pipeline does not use.
 *
 * Claude is therefore the *more* permissive path, which is the opposite of how
 * it looks: moving this step to Claude raised the largest PDF this app can
 * parse from ~15 MB to ~23 MB.
 *
 * It also means there is no useful fallback. A PDF too large for Anthropic is
 * too large for Gemini by a wider margin, so sending it there would pay for a
 * second request and fail anyway — with a provider error about inline data
 * rather than a sentence naming the limit. Over the ceiling the parse refuses.
 *
 * The limit nobody had encoded is the pre-existing one: `MAX_UPLOAD_BYTES` is
 * 500 MB, so this app has always accepted PDFs it could never parse, and found
 * out one provider error at a time.
 */
const REQUEST_LIMIT_BYTES: ReadonlyArray<readonly [string, number]> = [
  ["anthropic/", 32 * 1024 * 1024],
  ["google/", 20 * 1024 * 1024],
];

/** base64 carries 3 bytes in every 4. */
const BASE64_OVERHEAD = 4 / 3;

/** Room for the prompt and the JSON framing around the encoded PDF. */
const ENVELOPE_ALLOWANCE = 1024 * 1024;

/**
 * The largest raw PDF a model will take, derived from its request limit rather
 * than written down — a hand-copied byte count is the one that goes stale.
 *
 * `null` for a model with no limit recorded here, which is not read as
 * "unlimited" but as "do not guess": the parse proceeds and the provider
 * decides.
 */
export function maxInlinePdfBytes(model: string): number | null {
  const match = REQUEST_LIMIT_BYTES.find(([prefix]) => model.startsWith(prefix));
  if (!match) return null;
  return Math.floor((match[1] - ENVELOPE_ALLOWANCE) / BASE64_OVERHEAD);
}

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
  /** This model's raw-PDF ceiling, or null if none is recorded for it. */
  maxBytes: number | null;
  /** True when the PDF exceeds it — no provider here takes it inline. */
  overLimit: boolean;
}

/**
 * Which model parses a PDF of this size, and whether it can at all.
 *
 * Each provider's ceiling is applied to its own ids, so pointing
 * `MARKDOWN_MODEL` at a different provider gets that provider's limit rather
 * than inheriting one it does not have.
 */
export function markdownModelFor(bytes: number, preferred = MARKDOWN_MODEL): MarkdownModelChoice {
  const maxBytes = maxInlinePdfBytes(preferred);
  return { model: preferred, maxBytes, overLimit: maxBytes !== null && bytes > maxBytes };
}

/** Megabytes, for an error a person has to act on. */
export function asMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
