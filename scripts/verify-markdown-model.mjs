// Which model parses a PDF, and what happens when the parse is cut off.
//
// Two things decide whether moving this step to Claude is safe, and neither is
// about quality:
//
//  1. **The payload ceiling.** Anthropic caps the whole request at 32 MB and a
//     PDF is base64'd into it. `MAX_UPLOAD_BYTES` is 500 MB, so a document this
//     app already accepts can be 20× what the model will take. A PDF that
//     ingested yesterday must not stop ingesting because the model changed, so
//     an oversize one falls back to Gemini — which bills PDFs by page and has
//     no comparable ceiling.
//  2. **The cap is Anthropic's, not ours.** Pointing MARKDOWN_MODEL back at
//     Gemini must not inherit a limit that provider does not have, or the
//     fallback silently applies to the fallback.
//
// Pure: no network, no model, no credentials. Run: pnpm verify:markdown-model
import {
  MARKDOWN_FALLBACK_MODEL,
  MARKDOWN_MAX_OUTPUT_TOKENS,
  MAX_CLAUDE_PDF_BYTES,
  isAnthropicModel,
  markdownModelFor,
} from "@/lib/models";
import { MAX_UPLOAD_BYTES } from "@/lib/upload";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n    ${detail}` : ""}`); }
};

const MB = 1024 * 1024;
const CLAUDE = "anthropic/claude-sonnet-5-5";

console.log("A PDF the preferred model can take:");
{
  check("an ordinary document goes to the preferred model",
    markdownModelFor(4 * MB, CLAUDE).model === CLAUDE,
    JSON.stringify(markdownModelFor(4 * MB, CLAUDE)));
  check("and is reported as preferred, not as a fallback",
    markdownModelFor(4 * MB, CLAUDE).reason === "preferred");
  check("exactly at the cap is still allowed",
    markdownModelFor(MAX_CLAUDE_PDF_BYTES, CLAUDE).model === CLAUDE);
}

console.log("A PDF it cannot:");
{
  const over = markdownModelFor(MAX_CLAUDE_PDF_BYTES + 1, CLAUDE);
  check("one byte over falls back", over.model === MARKDOWN_FALLBACK_MODEL, JSON.stringify(over));
  check("and says why", over.reason === "oversize");
  // The reason this guard exists at all: the app's own ceiling is far higher
  // than the provider's, so this is a reachable state, not a theoretical one.
  check("the upload ceiling really is above the model's",
    MAX_UPLOAD_BYTES > MAX_CLAUDE_PDF_BYTES,
    `${MAX_UPLOAD_BYTES} vs ${MAX_CLAUDE_PDF_BYTES}`);
  check("a document at the upload ceiling still parses, via the fallback",
    markdownModelFor(MAX_UPLOAD_BYTES, CLAUDE).model === MARKDOWN_FALLBACK_MODEL);
  // 23 MB of PDF is ~31 MB base64'd, which must still fit Anthropic's 32 MB.
  check("the cap leaves room for base64 inflation",
    MAX_CLAUDE_PDF_BYTES * (4 / 3) < 32 * MB,
    `${((MAX_CLAUDE_PDF_BYTES * 4) / 3 / MB).toFixed(1)} MB encoded`);
}

console.log("The cap belongs to the provider that has it:");
{
  // If MARKDOWN_MODEL is pointed back at Gemini, there is nothing to fall back
  // *to* and no ceiling to apply — otherwise the fallback falls back to itself.
  const huge = markdownModelFor(200 * MB, MARKDOWN_FALLBACK_MODEL);
  check("an oversize PDF on the Gemini path is left alone",
    huge.model === MARKDOWN_FALLBACK_MODEL && huge.reason === "preferred",
    JSON.stringify(huge));
  check("the fallback is not an Anthropic id", !isAnthropicModel(MARKDOWN_FALLBACK_MODEL));
  check("an Anthropic id is recognised", isAnthropicModel(CLAUDE));
  check("a Google id is not", !isAnthropicModel("google/gemini-3.5-flash-lite"));
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

console.log(failures === 0 ? "\nAll markdown-model checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
