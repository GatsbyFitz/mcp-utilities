// Which model parses a PDF, and what happens when it cannot.
//
// Both providers take the PDF inline, base64'd into the request body, so the
// binding limit is request size — and the two do not agree on it. Anthropic
// allows 32 MB, Gemini 20 MB for inline data. That ordering is the whole point
// of these checks, because it is the opposite of how it reads:
//
//  1. **Claude is the more permissive path.** Moving this step to Claude
//     *raised* the largest parseable PDF, from ~15 MB to ~23 MB.
//  2. **So there is no useful fallback.** Anything too large for Anthropic is
//     too large for Gemini by a wider margin. Falling back would pay for a
//     second request and fail anyway, with a provider error about inline data
//     instead of a sentence naming the limit.
//  3. **The ceiling is reachable.** MAX_UPLOAD_BYTES is 500 MB, so this app
//     accepts PDFs it cannot parse on any provider, and always has.
//
// Pure: no network, no model, no credentials. Run: pnpm verify:markdown-model
import {
  MARKDOWN_MAX_OUTPUT_TOKENS,
  asMb,
  isAnthropicModel,
  markdownModelFor,
  maxInlinePdfBytes,
} from "@/lib/models";
import { MAX_UPLOAD_BYTES } from "@/lib/upload";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n    ${detail}` : ""}`); }
};

const MB = 1024 * 1024;
const CLAUDE = "anthropic/claude-sonnet-5-5";
const GEMINI = "google/gemini-3.5-flash-lite";

console.log("Each provider's own ceiling:");
{
  const claude = maxInlinePdfBytes(CLAUDE);
  const gemini = maxInlinePdfBytes(GEMINI);
  check("Anthropic's 32 MB request leaves ~23 MB of PDF",
    claude > 22 * MB && claude < 24 * MB, asMb(claude));
  check("Gemini's 20 MB request leaves ~14 MB of PDF",
    gemini > 13 * MB && gemini < 15 * MB, asMb(gemini));
  // The ordering this whole design turns on.
  check("Claude is the MORE permissive path, not the less",
    claude > gemini, `${asMb(claude)} vs ${asMb(gemini)}`);
  check("an unrecognised provider is 'do not guess', not 'unlimited'",
    maxInlinePdfBytes("someone/else-1") === null);
}

console.log("A PDF that fits:");
{
  const ok = markdownModelFor(4 * MB, CLAUDE);
  check("an ordinary document goes to the preferred model", ok.model === CLAUDE);
  check("and is not flagged", ok.overLimit === false, JSON.stringify(ok));
  check("exactly at the ceiling still fits",
    markdownModelFor(maxInlinePdfBytes(CLAUDE), CLAUDE).overLimit === false);
}

console.log("A PDF that does not:");
{
  const over = markdownModelFor(maxInlinePdfBytes(CLAUDE) + 1, CLAUDE);
  check("one byte over is refused", over.overLimit === true, JSON.stringify(over));
  // Not "fall back to Gemini": that request is rejected there too, and the
  // ceiling is lower, so the fallback costs a call and clarifies nothing.
  check("it is NOT redirected to another provider", over.model === CLAUDE);
  check("and it carries the number to put in the error", over.maxBytes > 0);
  check("the app's own ceiling is far above the provider's — this is reachable",
    MAX_UPLOAD_BYTES > maxInlinePdfBytes(CLAUDE) * 10,
    `${asMb(MAX_UPLOAD_BYTES)} upload vs ${asMb(maxInlinePdfBytes(CLAUDE))} parse`);
}

console.log("The ceiling belongs to the provider that has it:");
{
  // Pointing MARKDOWN_MODEL back at Gemini must get Gemini's limit, not
  // Anthropic's — a PDF between the two is fine on one and not the other.
  const between = (maxInlinePdfBytes(CLAUDE) + maxInlinePdfBytes(GEMINI)) / 2;
  check("a PDF between the two ceilings passes on Anthropic",
    markdownModelFor(between, CLAUDE).overLimit === false, asMb(between));
  check("and is refused on Gemini",
    markdownModelFor(between, GEMINI).overLimit === true, asMb(between));
  check("an Anthropic id is recognised", isAnthropicModel(CLAUDE));
  check("a Google id is not", !isAnthropicModel(GEMINI));
}

console.log("The output limit is named, not defaulted:");
{
  // The Anthropic API requires max_tokens and defaults it low enough to cut a
  // document off mid-sentence. Naming the model's documented maximum means a
  // truncated parse says the document is too long, not that we chose badly.
  check("the limit is the model's maximum, not a guess",
    MARKDOWN_MAX_OUTPUT_TOKENS === 128_000, String(MARKDOWN_MAX_OUTPUT_TOKENS));
  // ~80 chunks × 500 words is the observed shape of a document here; at ~1.3
  // tokens a word that is ~52k, so the limit is not a routine ceiling.
  check("it clears a typical document by a wide margin",
    MARKDOWN_MAX_OUTPUT_TOKENS > 2 * 80 * 500 * 1.3);
}

console.log("Sizes are reported in units a person can act on:");
{
  check("bytes render as megabytes", asMb(23 * MB) === "23.0 MB", asMb(23 * MB));
}

console.log(failures === 0 ? "\nAll markdown-model checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
