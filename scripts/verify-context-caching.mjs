/**
 * Does the contextualization prefix actually carry a cache breakpoint?
 *
 *   pnpm verify:context-caching
 *
 * `contextualizeChunks` sends the whole document on every call and varies only
 * the trailing chunk, so its input is roughly the document times the chunk
 * count — the largest model spend in the pipeline by a wide margin. On Gemini
 * that was absorbed by implicit prefix caching. Anthropic caches only up to an
 * explicit `cache_control` breakpoint, so on an `anthropic/…` model the
 * breakpoint *is* the economics of the step.
 *
 * And it fails silently in both directions:
 *
 *   - **No breakpoint** — every call re-pays for the whole document. Nothing
 *     throws, every context string comes back correct, and the cheapest step
 *     in the pipeline quietly becomes the most expensive.
 *   - **Breakpoint after the chunk** — each call writes a distinct cache entry
 *     that nothing ever reads. That is *worse* than not caching, because a
 *     write is billed above the base rate.
 *
 * Two things are checked, and they are different claims:
 *
 *   1. **The request.** Stub `fetch`, run the real step, and read what the SDK
 *      would have sent. Note what this can and cannot say: the gateway takes
 *      the AI SDK's own wire format and does the Anthropic translation server
 *      side, so what is asserted here is that the breakpoint reaches the
 *      gateway — not that the gateway relays it. That second hop is the same
 *      gap `verify:multimodal` splits into stages A and B, and the instrument
 *      for it is the step's own per-document cache log on a real ingestion.
 *   2. **The accounting.** Hand the step a reply that reports cache reads and
 *      check its log repeats them. That log is the only instrument pointed at
 *      hop two, so a wrong field name there would read as "0% cached" forever
 *      while the caching worked fine — or hide that it never worked at all.
 *
 * Offline and credential-free by design, the same shape as stage A of
 * `verify:multimodal` — it asserts the request, not the reply.
 */
import { contextualizeChunks } from "@/app/api/upload/steps/contextualizeChunks";
import { CONTEXT_MODEL, isAnthropicModel } from "@/lib/models";

let failed = false;
const fail = (message, detail) => {
  failed = true;
  console.log(`FAIL  ${message}${detail ? `\n      ${detail}` : ""}`);
};
const pass = (message) => console.log(`ok    ${message}`);

// Long enough to chunk several times, so there is a varying suffix to check the
// prefix against. Each clause is numbered so no two chunks come out identical —
// otherwise the distinctness check below would pass or fail on the fixture's
// repetition rather than on the step's behaviour.
const clause = (i) =>
  `Clause ${i}. The retailer must notify the Metering Coordinator of a change ` +
  `request within two business days, and the Metering Coordinator must respond ` +
  `before the next scheduled read. `;
const MARKDOWN = `# Retail Market Procedures\n\n${Array.from({ length: 400 }, (_, i) => clause(i + 1)).join("")}`;

// Numbers the log has to repeat back, chosen to be unmistakable in it.
const PROMPT_TOKENS = 31_000;
const CACHE_READ = 30_000;
const CACHE_WRITE = 500;

const reply = () =>
  new Response(
    JSON.stringify({
      content: [{ type: "text", text: "A clause about change-request notification." }],
      finishReason: "stop",
      usage: {
        inputTokens: {
          total: PROMPT_TOKENS,
          noCache: PROMPT_TOKENS - CACHE_READ - CACHE_WRITE,
          cacheRead: CACHE_READ,
          cacheWrite: CACHE_WRITE,
        },
        outputTokens: { total: 12, text: 12 },
      },
      warnings: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;

process.env.AI_GATEWAY_API_KEY ||= "offline-verify-context-caching";
// Set so the BYOK fragment is exercised: it must not move the breakpoint. A
// placeholder, and no request body is ever printed — this check must stay safe
// to run with a real key in the environment.
process.env.ANTHROPIC_API_KEY ||= "placeholder-not-a-key";

const requests = [];
const logged = [];

globalThis.fetch = async (_url, init) => {
  requests.push(typeof init?.body === "string" ? init.body : "");
  return reply();
};
console.log = (...args) => logged.push(args.join(" "));
console.warn = (...args) => logged.push(args.join(" "));

try {
  await contextualizeChunks("procedures.pdf", MARKDOWN);
} finally {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.warn = realWarn;
}

console.log(`Checking what CONTEXT_MODEL (${CONTEXT_MODEL}) is sent.\n`);

if (requests.length < 2) {
  fail(
    `only ${requests.length} request(s) captured — at least two are needed to compare prefixes`,
    "Either the step stopped calling the model, or the markdown no longer chunks."
  );
} else {
  pass(`${requests.length} calls captured, enough to compare prefixes`);
}

// ---------------------------------------------------------------------------
// What the model was actually sent
// ---------------------------------------------------------------------------
// Read off the wire rather than from the step's source: an option the SDK drops
// in transit is exactly the failure this is for, and reading source cannot see
// it. The gateway's format is the AI SDK's own, so `cacheControl` appears under
// `providerOptions` rather than as Anthropic's `cache_control`.
const bodies = requests.map((raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
});
if (bodies.some((b) => b === null)) fail("a request body was not JSON — cannot inspect it");

const parts = bodies
  .filter(Boolean)
  .map((body) => {
    const content = body.prompt?.find((m) => m.role === "user")?.content;
    return (Array.isArray(content) ? content : []).filter((p) => p?.type === "text");
  });

if (parts.length === 0 || parts.some((p) => p.length !== 2)) {
  fail(
    "a request did not carry exactly two text parts",
    `Part counts: ${parts.map((p) => p.length).join(", ") || "none"}. The document and the ` +
      `chunk must stay separate parts — a single concatenated string has nowhere to put a ` +
      `breakpoint.`
  );
} else {
  pass("every call sends the document and the chunk as two separate parts");
}

const cached = (part) => Boolean(part?.providerOptions?.anthropic?.cacheControl);

if (isAnthropicModel(CONTEXT_MODEL)) {
  if (parts.length > 0 && parts.every((p) => cached(p[0]))) {
    pass("the document part carries a cache breakpoint on every call");
  } else {
    fail(
      "the document part carries no cache breakpoint",
      "Without it this step re-pays for the whole document on every chunk — roughly the " +
        "document times the chunk count, with nothing failing to say so."
    );
  }

  // The expensive mistake, and the one that looks like success.
  if (parts.length > 0 && parts.every((p) => !cached(p[1]))) {
    pass("the chunk part carries none, so nothing varying sits inside the prefix");
  } else {
    fail(
      "the chunk part carries a cache breakpoint",
      "A breakpoint after the chunk makes every call write its own entry that nothing " +
        "ever reads, which costs more than not caching at all."
    );
  }

  // Billing, in the same body. Asserted by presence only — the key itself is
  // never read out of the request here.
  const byok = bodies
    .filter(Boolean)
    .every((b) => Array.isArray(b.providerOptions?.gateway?.byok?.anthropic));
  if (byok) pass("and the call carries BYOK, so Anthropic bills us rather than Vercel");
  else {
    fail(
      "the call carries no BYOK fragment",
      "With ANTHROPIC_API_KEY set these tokens should be invoiced to us; without it the " +
        "gateway pays with Vercel credits."
    );
  }
} else {
  pass(
    `CONTEXT_MODEL is ${CONTEXT_MODEL}, not an Anthropic model — no breakpoint asserted ` +
      `(this provider caches implicitly)`
  );
}

// ---------------------------------------------------------------------------
// Is the prefix the same prefix?
// ---------------------------------------------------------------------------
// Caching is prefix *matching*, so a document part differing by one byte
// between calls is never read from cache, breakpoint or no breakpoint.
const documents = parts.map((p) => p[0]?.text ?? "");
const chunks = parts.map((p) => p[1]?.text ?? "");

if (documents.length > 1 && new Set(documents).size === 1) {
  pass("the document part is byte-identical across calls, so the prefix can match");
} else {
  fail(
    `the document part differs between calls (${new Set(documents).size} distinct values)`,
    "A prefix that varies is never read from cache, however the breakpoint is placed."
  );
}

if (chunks.length > 1 && new Set(chunks).size === chunks.length) {
  pass("and each chunk part is distinct, so the suffix is doing the varying");
} else {
  fail(
    "chunk parts are not all distinct — the varying half is not varying",
    "Either chunking collapsed or the chunk is not reaching the second part."
  );
}

// Order is the mechanism: everything before the breakpoint is cached, so a
// varying part ahead of it cancels the whole thing.
if (documents.length > 0 && documents.every((d) => d.startsWith("<document>"))) {
  pass("and it comes first, ahead of anything that varies");
} else {
  fail(
    "the first part is not the document",
    `Starts with: ${JSON.stringify(documents[0]?.slice(0, 60) ?? "")}`
  );
}

// ---------------------------------------------------------------------------
// Does the step's own instrument read the right numbers?
// ---------------------------------------------------------------------------
const report = logged.find((line) => line.includes("[contextualizeChunks] procedures.pdf:"));
const n = (value) => value.toLocaleString("en-US");

if (!report) {
  fail("the step logged no cache report", `Captured: ${logged.length} line(s).`);
} else if (report.includes("reported no token counts")) {
  fail(
    "the step read no token counts from a reply that carried them",
    "`promptTokensFrom` is reading the wrong field off `usage`, which would report every " +
      "real ingestion as unmeasurable."
  );
} else {
  const calls = requests.length;
  const expectRead = CACHE_READ * calls;
  const expectWrite = CACHE_WRITE * calls;

  if (report.includes(`${n(expectRead)} read from cache`)) {
    pass("the log reports the cache reads the provider stated");
  } else {
    fail(
      `the log does not report ${n(expectRead)} cache reads`,
      `Logged: ${report}`
    );
  }

  if (report.includes(`${n(expectWrite)} written`)) {
    pass("and the writes separately, so write-only caching is visible");
  } else {
    fail(`the log does not report ${n(expectWrite)} cache writes`, `Logged: ${report}`);
  }

  // The share must be computed against reads, not reads plus writes: a prefix
  // that only ever writes is the failure, so it has to read as ~0%.
  const share = ((expectRead / (PROMPT_TOKENS * calls)) * 100).toFixed(1);
  if (report.includes(`(${share}%)`)) pass(`and the share as ${share}%`);
  else fail(`the log does not report the share as ${share}%`, `Logged: ${report}`);
}

console.log(
  failed ? "\nSome context-caching checks FAILED." : "\nAll context-caching checks passed."
);
process.exit(failed ? 1 : 0);
