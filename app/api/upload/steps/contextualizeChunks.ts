import { generateText } from "ai";
import { CONTEXT_MODEL, anthropicByok, isAnthropicModel } from "@/lib/models";
import { chunkText, extractTitle } from "@/lib/chunking";
import { mapPool } from "@/lib/pool";

// ---------------------------------------------------------------------------
// Step: Generate a short situating context for each chunk (Anthropic's
// "contextual retrieval" preprocessing), consumed by createEmbeddings to
// improve both dense and sparse retrieval. Kept as its own step so a retry
// of createEmbeddings (e.g. an Upstash upsert failure) doesn't re-run every
// contextualization call.
// ---------------------------------------------------------------------------
// Re-derives chunks from the markdown rather than receiving them, same as
// extractGraph — createEmbeddings does the same, so all three agree on
// boundaries via lib/chunking.

// ---------------------------------------------------------------------------
// Why the prompt is two parts rather than one string
// ---------------------------------------------------------------------------
// Every call here sends the *whole document* and varies only the trailing
// chunk, so this step's input is roughly the document times the chunk count —
// comfortably the largest model spend in the pipeline. It only stays
// affordable if the shared prefix is cached.
//
// Gemini did that implicitly, against any repeated prefix. Anthropic caches
// only up to an explicit `cache_control` breakpoint, so on this model the
// single interpolated string that used to be here would re-pay for the entire
// document on all ~80 calls: this step would go from the cheapest in the
// pipeline to the most expensive, with nothing failing to say so.
//
// Hence two text parts, in this order and no other:
//
//   1. the document, carrying the breakpoint — byte-identical on every call
//   2. the chunk and the instruction — different every call
//
// The breakpoint goes at the end of the *shared* portion. Put it at the end of
// the whole prompt instead and every request writes its own cache entry that
// nothing ever reads, which costs more than not caching at all. The order is
// the mechanism, not a style choice: caching is prefix matching, so anything
// that varies must come after everything that does not.
const DOCUMENT_PART = (document: string) => `<document>
${document}
</document>`;

const CHUNK_PART = (chunk: string) => `
Here is the chunk we want to situate within the whole document:
<chunk>
${chunk}
</chunk>

Give a short, succinct context (1-2 sentences) to situate this chunk within the overall document, for the purpose of improving search retrieval of the chunk. Answer only with the context, nothing else.`;

const MAX_CONTEXT = 500;

/** Marks the end of the cached prefix. Anthropic-only; other providers ignore it. */
const CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

// ---------------------------------------------------------------------------
// Was the prefix actually cached?
// ---------------------------------------------------------------------------
// Caching is invisible from the call site: a cached request and an uncached one
// return the same thing and differ only in the bill. The AI SDK reports the
// counts on `usage` in a provider-independent shape, so summing them per
// document turns "caching probably works" into a number in the log on every
// ingestion.
//
// Reads and writes are tallied separately because the failure mode is not "no
// caching" but *write-only* caching — a prefix that varies slightly writes a
// fresh entry per call and reads none, which is more expensive than no caching
// at all and looks identical from here. Writes without reads is the thing to
// notice, so the log says it in words rather than leaving it to be derived.

interface PromptTokens {
  prompt: number;
  cacheRead: number;
  cacheWrite: number;
  reported: boolean;
}

function promptTokensFrom(usage: {
  inputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
}): PromptTokens {
  const { inputTokens, inputTokenDetails } = usage;
  if (typeof inputTokens !== "number") {
    return { prompt: 0, cacheRead: 0, cacheWrite: 0, reported: false };
  }

  // Absent rather than zero is the normal shape for an uncached call, so a
  // missing count here is a real zero — unlike a missing inputTokens, which
  // means the provider said nothing and the question is unanswered.
  return {
    prompt: inputTokens,
    cacheRead: inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: inputTokenDetails?.cacheWriteTokens ?? 0,
    reported: true,
  };
}

/** One situating-context string per chunk, aligned by index; "" if generation failed for that chunk. */
export async function contextualizeChunks(fileName: string, markdown: string): Promise<string[]> {
  "use step";

  const title = extractTitle(markdown, fileName);
  const chunks = chunkText(markdown);
  const document = `${title}\n\n${markdown}`;
  const documentPart = DOCUMENT_PART(document);

  const tally = { prompt: 0, cacheRead: 0, cacheWrite: 0, calls: 0, reported: 0 };

  const contextFor = async (chunk: string, i: number): Promise<string> => {
    try {
      const result = await generateText({
        model: CONTEXT_MODEL,
        providerOptions: anthropicByok(CONTEXT_MODEL),
        messages: [
          {
            role: "user",
            content: [
              // Built once, outside this closure, so every call sends the
              // identical bytes. Rebuilding it per call would be the same
              // string today and the thing that silently stops matching the
              // moment anything per-chunk leaks into it.
              { type: "text", text: documentPart, providerOptions: CACHE_BREAKPOINT },
              { type: "text", text: CHUNK_PART(chunk) },
            ],
          },
        ],
      });

      const tokens = promptTokensFrom(result.usage);
      tally.calls += 1;
      tally.prompt += tokens.prompt;
      tally.cacheRead += tokens.cacheRead;
      tally.cacheWrite += tokens.cacheWrite;
      if (tokens.reported) tally.reported += 1;

      return result.text.trim().slice(0, MAX_CONTEXT);
    } catch (error) {
      // mapPool awaits every runner together, so an unhandled throw here would
      // sink an upload that has already paid for parsing. Fall back to no
      // context for this chunk rather than failing the whole upload.
      console.warn(
        `[contextualizeChunks] ${fileName} chunk ${i + 1}/${chunks.length}: context generation failed, skipping`,
        error
      );
      return "";
    }
  };

  if (chunks.length === 0) return [];

  // The first call is made alone, before the rest fan out.
  //
  // The cache has to be *written* before it can be read, and a write only
  // lands when a request completes. Firing five identical-prefix calls at once
  // into a cold cache pays full price for all five and writes the same entry
  // five times — on Anthropic that is worse than full price, since a write is
  // billed above the base rate. One call first warms it, and costs one call's
  // worth of latency on a step that already takes minutes.
  //
  // This was already the shape under Gemini's implicit caching, for the same
  // reason stated differently: a prefix is only cached against a request the
  // provider has already seen.
  const first = await contextFor(chunks[0], 0);
  const rest = await mapPool(chunks.slice(1), 5, (chunk, i) => contextFor(chunk, i + 1));

  logPrefixCaching(fileName, tally);

  return [first, ...rest];
}

/** One line per document saying what the prefix actually cost. */
function logPrefixCaching(
  fileName: string,
  tally: { prompt: number; cacheRead: number; cacheWrite: number; calls: number; reported: number }
): void {
  const n = (value: number) => value.toLocaleString("en-US");

  if (tally.reported === 0) {
    console.warn(
      `[contextualizeChunks] ${fileName}: ${tally.calls} call(s), but the provider ` +
        `reported no token counts — prefix caching can be neither confirmed nor ruled out here`
    );
    return;
  }

  const share = tally.prompt > 0 ? (tally.cacheRead / tally.prompt) * 100 : 0;
  console.log(
    `[contextualizeChunks] ${fileName}: ${tally.calls} call(s), ` +
      `${n(tally.prompt)} prompt tokens, ${n(tally.cacheRead)} read from cache (${share.toFixed(1)}%)` +
      `, ${n(tally.cacheWrite)} written` +
      (tally.reported < tally.calls ? `; ${tally.calls - tally.reported} call(s) reported nothing` : "")
  );

  // The expensive failure, called out rather than left to be inferred from two
  // numbers: a prefix that writes on every call and is never read is costlier
  // than sending it uncached. On this model that means the breakpoint is in the
  // wrong place or something per-chunk has leaked into the document part.
  if (tally.calls > 1 && tally.cacheWrite > 0 && tally.cacheRead === 0) {
    console.warn(
      `[contextualizeChunks] ${fileName}: ${tally.calls} call(s) wrote ${n(tally.cacheWrite)} ` +
        `cache token(s) and read none — the prefix is not matching between calls, which costs ` +
        `more than not caching it. Check that the document part is byte-identical on every call.`
    );
  } else if (isAnthropicModel(CONTEXT_MODEL) && tally.calls > 1 && tally.cacheWrite === 0 && tally.cacheRead === 0) {
    console.warn(
      `[contextualizeChunks] ${fileName}: ${tally.calls} call(s) on an Anthropic model with no ` +
        `cache activity at all — the cache_control breakpoint is not reaching the provider. ` +
        `This step re-paid for the whole document on every call.`
    );
  }
}
