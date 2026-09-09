/**
 * Is the image actually reaching the embedding model?
 *
 *   node --env-file=.env.local scripts/verify-multimodal-embedding.mjs
 *   pnpm verify:multimodal
 *
 * Plain ESM and `--env-file` (native since Node 20.6) so this needs no TypeScript
 * runner, no network install, and no framework — the repo has none of those.
 *
 * Why it exists: figures are embedded from their description *and* their pixels
 * via `providerOptions.google.content`. If that option is dropped anywhere in
 * transit the call still succeeds and still returns a 1536-dimension vector —
 * it has simply never seen the image. Nothing throws and nothing logs. The
 * feature keeps working off descriptions alone, so this is not a breakage; it
 * decides whether you are getting the multimodal upgrade you are paying request
 * payload for, and stops "multimodal didn't help on this corpus" being
 * concluded about a path that was never switched on.
 *
 * Two stages, because there are two places it can be lost, and the fix differs:
 *   A. the SDK not putting it in the request   — offline, no credentials
 *   B. the gateway not relaying it to Google   — needs a live call
 */
import { embedMany } from "ai";

// 2x2 red PNG, inline so there is no fixture to keep in sync.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z4AAT" +
  "AxIYFTAKAAAAAD//wMAAA8AAe8VJmMAAAAASUVORK5CYII=";

const MODEL = "google/gemini-embedding-2";
const DIMENSIONS = 1536;
const MAX_IMAGES_PER_REQUEST = 6; // gemini-embedding-2 API limit
const BATCH = 4;                  // MAX_FIGURES_PER_EMBED_REQUEST
const DESCRIPTION = "Process flow: the Retailer notifies the Metering Coordinator.";

const options = { outputDimensionality: DIMENSIONS, taskType: "RETRIEVAL_DOCUMENT" };
const withImage = (text) => [
  { text },
  { inlineData: { mimeType: "image/png", data: PNG } },
];

let failed = false;
const fail = (message) => {
  failed = true;
  console.log(`FAIL  ${message}`);
};
const pass = (message) => console.log(`ok    ${message}`);

// ---------------------------------------------------------------------------
// Stage A — offline. Capture what the SDK would send, without sending it.
// ---------------------------------------------------------------------------
async function stageA() {
  console.log("Stage A — request contents (offline, no credentials)\n");

  const realFetch = globalThis.fetch;
  const realKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY ||= "offline-stage-a";

  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push(body);
    return new Response(JSON.stringify({ embeddings: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    // Batched exactly as embedFigures batches, so this also covers the
    // batching itself — which is invisible from the call site and would
    // otherwise have nothing watching it if embedMany's behaviour changed.
    const figures = Array.from({ length: 14 }, (_, i) => `Figure ${i + 1}`);
    for (let start = 0; start < figures.length; start += BATCH) {
      const batch = figures.slice(start, start + BATCH);
      try {
        await embedMany({
          model: MODEL,
          values: batch,
          providerOptions: { google: { ...options, content: batch.map(withImage) } },
        });
      } catch {
        // The stubbed response is not a real one; only the request matters.
      }
    }
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
  }

  if (requests.length === 0) {
    fail("no request was captured — the SDK never called fetch");
    return;
  }

  const carriesImage = requests.every((b) => b.includes("inlineData") && b.includes(PNG.slice(0, 40)));
  carriesImage
    ? pass("the request body carries `inlineData` and the PNG bytes")
    : fail("the request body has no image — the SDK is not mapping providerOptions.google.content");

  const counts = requests.map((b) => (b.match(/inlineData/g) || []).length);
  const worst = Math.max(...counts);
  worst <= MAX_IMAGES_PER_REQUEST
    ? pass(`14 figures sent as ${requests.length} requests, at most ${worst} images each (limit ${MAX_IMAGES_PER_REQUEST})`)
    : fail(`a request carried ${worst} images, over the limit of ${MAX_IMAGES_PER_REQUEST} — batching in embedFigures has regressed`);

  const aligned = requests.every((b) => {
    const parsed = JSON.parse(b);
    return parsed.values.length === parsed.providerOptions.google.content.length;
  });
  aligned
    ? pass("`values` and `content` are the same length in every request")
    : fail("`values` and `content` lengths differ — vectors would attach to the wrong figures");
}

// ---------------------------------------------------------------------------
// Stage B — live. Only the gateway hop is left to prove.
// ---------------------------------------------------------------------------
async function stageB() {
  console.log("\nStage B — gateway relay (live call)\n");

  if (!process.env.AI_GATEWAY_API_KEY) {
    console.log("skip  AI_GATEWAY_API_KEY not set. Stage A still applies; run with");
    console.log("      `node --env-file=.env.local scripts/verify-multimodal-embedding.mjs`");
    console.log("      to check whether the gateway forwards the image.");
    return;
  }

  const [textOnly, multimodal] = await Promise.all([
    embedMany({ model: MODEL, values: [DESCRIPTION], providerOptions: { google: options } }),
    embedMany({
      model: MODEL,
      values: [DESCRIPTION],
      providerOptions: { google: { ...options, content: [withImage(DESCRIPTION)] } },
    }),
  ]);

  const a = textOnly.embeddings[0];
  const b = multimodal.embeddings[0];

  if (a.length !== DIMENSIONS || b.length !== DIMENSIONS) {
    fail(`expected ${DIMENSIONS} dimensions, got ${a.length} and ${b.length} — the index expects ${DIMENSIONS}`);
    return;
  }
  pass(`both embeddings are ${DIMENSIONS}-dimensional`);

  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const similarity = dot / (Math.sqrt(na) * Math.sqrt(nb));
  console.log(`      cosine(description, description+image) = ${similarity.toFixed(6)}`);

  // Identical vectors mean the same input produced the same output, i.e. the
  // image was never part of what was embedded.
  if (similarity > 0.9999) {
    fail("the vectors are identical — the gateway dropped `content`");
    console.log("      Figures are being embedded from their descriptions only.");
    console.log("      Remedy: set GOOGLE_GENERATIVE_AI_API_KEY to route this one call");
    console.log("      through @ai-sdk/google directly (see lib/embedding.ts).");
    return;
  }
  pass("the image changed the embedding — the gateway forwards `content`");
}

await stageA();
await stageB();

console.log(failed ? "\nFAILED" : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
