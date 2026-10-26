// ---------------------------------------------------------------------------
// One definition of every generative model, as lib/embedding.ts is for the
// embedding one.
//
// Routed through AI Gateway, like everything else here, so spend and traces
// stay in one place. The gateway is the transport; it is not necessarily who
// pays. See `anthropicByok` below — Anthropic usage is billed to our own
// Anthropic account while still going through the gateway.
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
 * One model id per *purpose*, not one for "extraction".
 *
 * These five calls were a single `EXTRACTION_MODEL`, which made moving them a
 * single decision — and they do not deserve one. They differ by two orders of
 * magnitude in volume and they fail in unrelated ways, so each names its own
 * model and each moved, or did not, for its own reason.
 *
 * Every `anthropic/…` id here is billed to our Anthropic account through
 * `anthropicByok`, not to Vercel credits.
 */

/**
 * `inferMappings` — once per sheet, ~16 per workbook.
 *
 * Sonnet because this is the call that decides whether a regulatory number is
 * filed under the right quarter. The AER's columns *are* periods, and a model
 * that reports one header row of metrics collapses five quarters onto one key
 * and leaves a real number from the wrong three months under a correct-looking
 * label. `pnpm verify:aer-inference` runs this exact model against a real
 * sheet and checks five values against the cells they came from; it is the
 * only thing standing between a weaker model and silently wrong statistics.
 */
export const SHEET_MAPPING_MODEL = "anthropic/claude-sonnet-5-5";

/**
 * `extractProcesses` — once per figure, vision plus Mermaid generation.
 *
 * Sonnet because transcribing a flowchart into valid Mermaid is the hardest
 * thing asked of a model here, and invalid Mermaid fails *silently*: an empty
 * iframe with nothing saying why. There is one repair round and then the
 * diagram is stored flagged invalid, so a weaker model costs diagrams rather
 * than erroring.
 */
export const PROCESS_MODEL = "anthropic/claude-sonnet-5-5";

/**
 * `extractGraph` — once per chunk, ~80 per document.
 *
 * Haiku: entity and relation extraction from a single chunk is a short,
 * bounded task at high volume, which is the tier Haiku exists for. The chunk
 * is the whole input, so there is no shared prefix to cache and nothing to
 * gain from a larger model.
 */
export const GRAPH_MODEL = "anthropic/claude-haiku-5-5";

/**
 * `contextualizeChunks` — once per chunk, ~80 per document, and the largest
 * input in the pipeline by a wide margin.
 *
 * Haiku, and it only works at all with explicit caching. Every call sends the
 * *whole document* and varies only the trailing chunk, so the step's input is
 * roughly the document times the chunk count. Gemini absorbed that with
 * implicit prefix caching; Anthropic caches only against an explicit
 * `cache_control` breakpoint, which is why moving this one needed a code
 * change rather than a new string — see the breakpoint in
 * `contextualizeChunks.ts`. Moved without it, this becomes the most expensive
 * step in the pipeline instead of the cheapest.
 */
export const CONTEXT_MODEL = "anthropic/claude-haiku-5-5";

/**
 * `extractFigures` — once per page, vision, returning a bounding box.
 *
 * **Deliberately still Gemini**, and the only one that did not move. It
 * returns normalised boxes in Gemini's own `[ymin, xmin, ymax, xmax]`
 * convention, and a box read in the wrong order still falls in range, still
 * passes validation and still produces a plausible-looking PNG — a tall slice
 * down the left of the page with the diagram cut off. There is no error to
 * catch, so changing this model means rendering crops and looking at them,
 * not swapping a string. Until someone does that, the convention the prompt
 * and `lib/figures.ts` were written against is the one in use.
 */
export const FIGURE_BOX_MODEL = "google/gemini-3.5-flash-lite";

/**
 * Reranking, on the query side. Shared by `search_docs` and `find_reference`
 * so retrieval is ordered the same way wherever it happens.
 *
 * It earns its place in `find_reference` for a reason worth recording: the
 * hybrid index's own score is reciprocal-rank fusion, which measures *rank*,
 * not relevance, and so cannot tell a good match from a bad one. The
 * reranker's score can, which is what makes a relevance floor possible at all.
 *
 * Cohere, not Anthropic, and not by choice: Anthropic publishes no reranker.
 * The same is true of `EMBEDDING_MODEL` in lib/embedding.ts — no embedding
 * model — so those two calls stay where they are whatever the billing says.
 */
export const RERANK_MODEL = "cohere/rerank-v3.5";

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

/**
 * Bill Anthropic usage to our own Anthropic account, through the gateway.
 *
 * By default an `anthropic/…` model routed through AI Gateway is paid for with
 * Vercel credits. Request-scoped BYOK changes who pays without changing
 * anything else: the gateway still routes, rate-limits, retries and records
 * the trace, and Anthropic invoices us directly for the tokens.
 *
 * Request-scoped rather than a key saved in the gateway dashboard, for the
 * reason this file exists at all — a dashboard setting is invisible from the
 * code, so nobody reading the call site can tell who is being billed. This way
 * it is in the diff.
 *
 * **Degrades rather than failing.** With no `ANTHROPIC_API_KEY` set the call
 * still runs and Vercel still pays, because a missing billing credential is
 * not a reason to stop ingesting a document. That makes it silent, which is
 * the trade — so `createMarkdown` logs which way it went, the same reason
 * `contextualizeChunks` logs its cache-hit rate.
 *
 * Returns a fragment to spread into `providerOptions`, empty when unset. The
 * key is read here and nowhere else, and is never logged.
 */
export function anthropicByok(model: string): {
  gateway?: { byok: { anthropic: { apiKey: string }[] } };
} {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !isAnthropicModel(model)) return {};
  return { gateway: { byok: { anthropic: [{ apiKey }] } } };
}

/** Whether this call will be billed to us rather than to Vercel. */
export function billsToAnthropic(model: string): boolean {
  return isAnthropicModel(model) && Boolean(process.env.ANTHROPIC_API_KEY);
}

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
