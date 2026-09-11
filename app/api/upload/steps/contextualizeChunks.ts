import { generateText } from "ai";
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

const CONTEXT_PROMPT = (document: string, chunk: string) => `<document>
${document}
</document>

Here is the chunk we want to situate within the whole document:
<chunk>
${chunk}
</chunk>

Give a short, succinct context (1-2 sentences) to situate this chunk within the overall document, for the purpose of improving search retrieval of the chunk. Answer only with the context, nothing else.`;

const MAX_CONTEXT = 500;

// ---------------------------------------------------------------------------
// Was the prefix actually cached?
// ---------------------------------------------------------------------------
// This step sends the whole document as the prefix of every call and varies
// only the trailing chunk, so its input is roughly the document times the chunk
// count — the largest model spend in the pipeline by a wide margin. Gemini
// caches a repeated prefix implicitly, which is why the first call is made
// alone below, but implicit caching is invisible from the call site: a cached
// request and an uncached one are indistinguishable apart from the bill.
//
// Gemini reports `cachedContentTokenCount` alongside `promptTokenCount`, so the
// answer is in the response. Summing it per document turns "caching probably
// works" into a number in the log on every ingestion. Nothing here changes
// behaviour — if the counts are absent the step runs exactly as before and the
// log says the question is unanswered rather than implying either answer.

interface PromptTokens {
  prompt: number;
  cached: number;
  reported: boolean;
}

/**
 * Digs `usageMetadata` out of whatever key the provider metadata arrived under.
 *
 * Not hardcoded to `google` because these calls go through the AI Gateway
 * rather than `@ai-sdk/google` directly, and the gateway is free to key
 * pass-through metadata under its own name. Searching every key costs nothing
 * and means a rename upstream degrades to "not reported" rather than to a
 * silently wrong zero.
 */
function promptTokensFrom(metadata: unknown): PromptTokens {
  const empty = { prompt: 0, cached: 0, reported: false };
  if (!metadata || typeof metadata !== "object") return empty;

  for (const provider of Object.values(metadata as Record<string, unknown>)) {
    const usage = (provider as { usageMetadata?: unknown } | null)?.usageMetadata;
    if (!usage || typeof usage !== "object") continue;

    const { promptTokenCount, cachedContentTokenCount } = usage as {
      promptTokenCount?: number | null;
      cachedContentTokenCount?: number | null;
    };
    if (typeof promptTokenCount !== "number") continue;

    return {
      prompt: promptTokenCount,
      // Absent rather than zero is the normal shape for an uncached call, so a
      // missing count here is a real zero, unlike a missing promptTokenCount.
      cached: typeof cachedContentTokenCount === "number" ? cachedContentTokenCount : 0,
      reported: true,
    };
  }

  return empty;
}

/** One situating-context string per chunk, aligned by index; "" if generation failed for that chunk. */
export async function contextualizeChunks(fileName: string, markdown: string): Promise<string[]> {
  "use step";

  const title = extractTitle(markdown, fileName);
  const chunks = chunkText(markdown);
  const document = `${title}\n\n${markdown}`;

  const tally = { prompt: 0, cached: 0, calls: 0, reported: 0 };

  const contextFor = async (chunk: string, i: number): Promise<string> => {
    try {
      const result = await generateText({
        model: "google/gemini-3.5-flash-lite",
        prompt: CONTEXT_PROMPT(document, chunk),
      });

      const tokens = promptTokensFrom(result.providerMetadata);
      tally.calls += 1;
      tally.prompt += tokens.prompt;
      tally.cached += tokens.cached;
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
  // Every call here sends the *entire document* as the prompt's prefix and
  // differs only in the chunk at the end, so this step's input is roughly the
  // document times the chunk count — comfortably the largest model spend in
  // the pipeline. Gemini caches a repeated prefix implicitly, but only against
  // a request it has already seen: firing five identical-prefix calls at once
  // into a cold cache pays full price for all five. One call first warms it,
  // and costs one call's worth of latency on a step that already takes
  // minutes.
  const first = await contextFor(chunks[0], 0);
  const rest = await mapPool(chunks.slice(1), 5, (chunk, i) => contextFor(chunk, i + 1));

  logPrefixCaching(fileName, tally);

  return [first, ...rest];
}

/** One line per document saying what the prefix actually cost. */
function logPrefixCaching(
  fileName: string,
  tally: { prompt: number; cached: number; calls: number; reported: number }
): void {
  const n = (value: number) => value.toLocaleString("en-US");

  if (tally.reported === 0) {
    console.warn(
      `[contextualizeChunks] ${fileName}: ${tally.calls} call(s), but the provider ` +
        `reported no token counts — prefix caching can be neither confirmed nor ruled out here`
    );
    return;
  }

  const share = tally.prompt > 0 ? (tally.cached / tally.prompt) * 100 : 0;
  console.log(
    `[contextualizeChunks] ${fileName}: ${tally.calls} call(s), ` +
      `${n(tally.prompt)} prompt tokens, ${n(tally.cached)} of them cached (${share.toFixed(1)}%)` +
      (tally.reported < tally.calls ? `; ${tally.calls - tally.reported} call(s) reported nothing` : "")
  );
}
