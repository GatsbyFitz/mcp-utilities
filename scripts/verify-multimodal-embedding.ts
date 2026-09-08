/**
 * Does the AI Gateway actually forward `providerOptions.google.content`?
 *
 * Run once, with .env.local loaded:
 *   pnpm dlx tsx scripts/verify-multimodal-embedding.ts
 *
 * Why this exists: figures are embedded from their description *and* their
 * pixels, via `content`. If the gateway drops that option in transit, the call
 * still succeeds and still returns a 1536-dimension vector — it is just a
 * description-only embedding. Nothing throws, nothing logs, and the feature
 * silently degrades to what it would have been without any image at all.
 *
 * So the test is not "did the call work" but "did the pixels change the
 * answer": embed one description twice, once with an image attached and once
 * without, and compare. Identical vectors mean the option never arrived.
 */
import { embedMany } from "ai";

// A 2x2 red PNG, inline so the script needs no fixture file.
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z4AAT" +
  "AxIYFTAKAAAAAD//wMAAA8AAe8VJmMAAAAASUVORK5CYII=";

const DESCRIPTION = "Process flow: the Retailer notifies the Metering Coordinator.";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  const base = {
    model: "google/gemini-embedding-2" as const,
    values: [DESCRIPTION],
  };
  const options = { outputDimensionality: 1536, taskType: "RETRIEVAL_DOCUMENT" };

  const textOnly = await embedMany({
    ...base,
    providerOptions: { google: options },
  });

  const withImage = await embedMany({
    ...base,
    providerOptions: {
      google: {
        ...options,
        content: [
          [
            { text: DESCRIPTION },
            { inlineData: { mimeType: "image/png", data: RED_PNG_BASE64 } },
          ],
        ],
      },
    },
  });

  const a = textOnly.embeddings[0];
  const b = withImage.embeddings[0];
  const similarity = cosine(a, b);

  console.log(`dimensions:      ${a.length} / ${b.length}`);
  console.log(`cosine(text, text+image): ${similarity.toFixed(6)}`);

  if (a.length !== 1536 || b.length !== 1536) {
    console.log("\nFAIL — outputDimensionality was not honoured; the index expects 1536.");
    process.exit(1);
  }

  // Exactly 1 would mean the same input produced the same vector, i.e. the
  // image was never part of the request.
  if (similarity > 0.9999) {
    console.log(
      "\nFAIL — the vectors are identical, so `content` was dropped in transit.\n" +
        "Figures would be embedded from their description only.\n" +
        "Fix: call @ai-sdk/google directly with GOOGLE_GENERATIVE_AI_API_KEY in\n" +
        "app/api/upload/steps/embedFigures.ts, instead of the bare gateway model string."
    );
    process.exit(1);
  }

  console.log("\nPASS — the image changed the embedding, so `content` is being forwarded.");
}

main().catch((error) => {
  console.error("verification failed to run:", error);
  process.exit(1);
});
