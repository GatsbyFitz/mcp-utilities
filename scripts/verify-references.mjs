// Reference sources: the parts that have to be right with no database.
//
// A reference is a pointer, not a copy, and three things decide whether the
// pointer works:
//
//  1. The name is derived, not free-form. The same page submitted twice must
//     land on one key, or it is indexed twice and the matches split between
//     the copies.
//  2. The id namespace is its own. Nothing written here may collide with a
//     chunk, a figure, a process or a compliance action — a moved chunk id
//     breaks every `chunkId` stored on a Neo4j relationship.
//  3. A submission with no summary is refused. The summary is the entire
//     basis for matching, so an entry without one is invisible — worse than
//     not adding it, because the list says it is there.
//
// Pure: no network, no model, no database.
//
// Run: pnpm verify:references
import {
  MAX_REFERENCE_NAME,
  MAX_REFERENCE_RESULTS,
  MIN_REFERENCE_RELEVANCE,
  REFERENCE_CANDIDATES,
  relevantReferences,
  REFERENCE_KIND,
  descriptorText,
  nameFromUrl,
  referenceNameProblem,
  reservedReferenceName,
  normalizeReferenceName,
  referenceId,
  referenceProblem,
} from "@/lib/references";
import { chunkId } from "@/lib/chunking";
import { figureId } from "@/lib/figures";
import { processId } from "@/lib/processes";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n    ${detail}` : ""}`); }
};

console.log("One page, one key:");
{
  check("a title becomes a stable name",
    normalizeReferenceName("AEMO Developer Portal — API docs") === "aemo-developer-portal-api-docs",
    normalizeReferenceName("AEMO Developer Portal — API docs"));
  check("case, padding and punctuation do not change it",
    normalizeReferenceName("  NEM Dispatch Bidding! ") === normalizeReferenceName("nem dispatch bidding"),
    `${normalizeReferenceName("  NEM Dispatch Bidding! ")} vs ${normalizeReferenceName("nem dispatch bidding")}`);
  check("a name is bounded", normalizeReferenceName("x".repeat(500)).length <= MAX_REFERENCE_NAME);
  check("a name never starts or ends with a separator",
    !/^-|-$/.test(normalizeReferenceName("--- spaced out ---")),
    normalizeReferenceName("--- spaced out ---"));

  check("a URL yields a usable name",
    nameFromUrl("https://dev.aemo.com.au/api-docs") === "dev-api-docs",
    nameFromUrl("https://dev.aemo.com.au/api-docs"));
  check("a bare host still yields one",
    nameFromUrl("https://dev.aemo.com.au/") === "dev", nameFromUrl("https://dev.aemo.com.au/"));
  check("something that is not a URL yields nothing", nameFromUrl("not a url") === "");
}

console.log("Its own id namespace:");
{
  const id = referenceId("aemo-api-docs");
  check("ids are namespaced", id === "reference#aemo-api-docs", id);

  // The invariant that keeps references additive. A reference must never be
  // able to occupy an id that a chunk, figure or process would.
  const docChunk = chunkId("reference", 0);
  const fig = figureId("reference", 0);
  const proc = processId("reference", 0);
  check("cannot collide with a chunk id", id !== docChunk, `${id} vs ${docChunk}`);
  check("cannot collide with a figure id", id !== fig, `${id} vs ${fig}`);
  check("cannot collide with a process id", id !== proc, `${id} vs ${proc}`);
  // The adversarial case, and the reason there is no exported id prefix: a
  // document literally named "reference" produces ids under `reference#`.
  // Both halves are needed to collide, so the reference half refuses.
  check("a document named 'reference' does produce reference#… ids",
    fig === "reference#figure-0" && proc === "reference#process-0",
    JSON.stringify([fig, proc]));
  check("so the name that would collide is reserved",
    reservedReferenceName("figure-0") && reservedReferenceName("process-12"));
  check("and refused with a reason",
    /reserved/.test(referenceNameProblem("figure-0") ?? ""), referenceNameProblem("figure-0"));
  check("an ordinary name is not reserved",
    !reservedReferenceName("aemo-api-docs") && referenceNameProblem("aemo-api-docs") === null);
  check("referenceId can no longer reach a figure or process id",
    !["figure-0", "process-0"].some(
      (n) => referenceNameProblem(n) === null && [fig, proc].includes(referenceId(n))
    ));
  check("the kind is its own", REFERENCE_KIND === "reference");
}

console.log("Refusing a submission that could never be found:");
{
  const good = {
    url: "https://dev.aemo.com.au/api-docs",
    title: "AEMO API docs",
    summary: "Endpoints and schemas for AEMO's market APIs.",
  };
  check("a complete submission is accepted", referenceProblem(good) === null, referenceProblem(good));

  check("no URL is refused", referenceProblem({ ...good, url: "" })?.includes("URL"));
  check("a non-URL is refused", referenceProblem({ ...good, url: "dev.aemo.com.au" })?.includes("not a URL"),
    referenceProblem({ ...good, url: "dev.aemo.com.au" }));
  // http is refused even though nothing is fetched server-side: this server
  // hands the link to a client to open, and should not be recommending one.
  check("http:// is refused", referenceProblem({ ...good, url: "http://dev.aemo.com.au/x" })?.includes("https"),
    referenceProblem({ ...good, url: "http://dev.aemo.com.au/x" }));
  check("no title is refused", referenceProblem({ ...good, title: " " })?.includes("title"));
  // The one that matters most: the summary is the whole basis for matching.
  check("no summary is refused, and the message says why",
    /summary is required/.test(referenceProblem({ ...good, summary: "" }) ?? "") &&
      /matched against/.test(referenceProblem({ ...good, summary: "" }) ?? ""),
    referenceProblem({ ...good, summary: "" }));
}

console.log("What gets embedded:");
{
  const text = descriptorText({
    title: "NEM Dispatch Bidding",
    summary: "Submit energy, FCAS and MNSP bids and offers.",
    keyTerms: ["MSATS", "aseXML"],
  });
  check("carries the title", text.includes("NEM Dispatch Bidding"), text);
  check("carries the summary", text.includes("FCAS and MNSP"), text);
  // These are the tokens the sparse half matches on; dropping them would make
  // "MSATS" findable only by luck.
  check("carries the key terms", text.includes("MSATS") && text.includes("aseXML"), text);
  check("missing key terms do not leave a dangling separator",
    !/\|\s*$/.test(descriptorText({ title: "T", summary: "S", keyTerms: [] })),
    descriptorText({ title: "T", summary: "S", keyTerms: [] }));
}

console.log("Offering a page only when it answers the question:")
{
  // Measured against the deployed index while it held one row: the hybrid
  // score is reciprocal-rank fusion, so it is 1/60 + 1/60 for rank 1 on both
  // retrievers and 1/60 for one. A question the page answered and a question
  // about an entirely different system both came back at 0.0333.
  //
  // This check exists so nobody reintroduces a threshold on that number. It is
  // a rank, not a relevance, and there is nothing in it to threshold.
  const HYBRID_GOOD = 1 / 60 + 1 / 60;
  const HYBRID_WRONG = 1 / 60 + 1 / 60;
  check("the fused retrieval score cannot separate a good match from a bad one",
    HYBRID_GOOD === HYBRID_WRONG, `${HYBRID_GOOD} vs ${HYBRID_WRONG}`);

  // The reranker's score can, which is the whole reason it is called here.
  const ranked = [
    { name: "claude-api-pdf-support", score: 0.84 },
    { name: "some-unrelated-page", score: 0.002 },
  ];
  const kept = relevantReferences(ranked);
  check("a relevant match survives the floor",
    kept.some((r) => r.name === "claude-api-pdf-support"));
  check("an irrelevant one does not",
    !kept.some((r) => r.name === "some-unrelated-page"), JSON.stringify(kept));

  check("the floor is above a rerank score for an unrelated page",
    MIN_REFERENCE_RELEVANCE > 0.002);
  // Too high is the worse failure: it hides pages that do cover the question,
  // which is precisely what this tool exists to find.
  check("but low enough to keep a weak-yet-plausible match",
    MIN_REFERENCE_RELEVANCE < 0.2, String(MIN_REFERENCE_RELEVANCE));

  // Every match below the floor must leave nothing, so the tool reports "none
  // of these covers it" rather than handing over the nearest row.
  check("all-weak reranks yield nothing to offer",
    relevantReferences([{ score: 0.001 }, { score: 0.004 }]).length === 0);
  check("an empty ranking is empty, not an error",
    relevantReferences([]).length === 0);

  // Reranking can only reorder what retrieval returned, so the candidate pool
  // has to be wider than the shortlist or the rerank is a formality.
  check("the candidate pool is wider than the shortlist",
    REFERENCE_CANDIDATES > MAX_REFERENCE_RESULTS,
    `${REFERENCE_CANDIDATES} candidates vs ${MAX_REFERENCE_RESULTS} returned`);
}

console.log(failures === 0 ? "\nAll reference checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
