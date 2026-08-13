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

/** One situating-context string per chunk, aligned by index; "" if generation failed for that chunk. */
export async function contextualizeChunks(fileName: string, markdown: string): Promise<string[]> {
  "use step";

  const title = extractTitle(markdown, fileName);
  const chunks = chunkText(markdown);

  return mapPool(chunks, 5, async (chunk, i) => {
    try {
      const { text } = await generateText({
        model: "google/gemini-3.5-flash-lite",
        prompt: CONTEXT_PROMPT(`${title}\n\n${markdown}`, chunk),
      });
      return text.trim().slice(0, MAX_CONTEXT);
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
  });
}
