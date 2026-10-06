// The `kb://documents` resource reports how many figures and processes each
// document has, so a model can tell whether display_process is worth calling
// for it. The rule worth pinning is the one that is easy to get wrong:
//
//   null  = the index could not be counted
//   0     = the document genuinely has none
//
// Collapsing them tells a model "no diagrams here" when the truth is that we
// could not ask. There is no database in this environment and the Neon
// serverless driver cannot reach a local Postgres, so the join is exercised
// directly rather than through the resource.
//
// Offline, no credentials. Run: pnpm verify:kb-documents
import { documentEntries } from "@/lib/documentList";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n    ${detail}` : ""}`); }
};

const rows = [
  { id: "1", name: "has-both.pdf", chunks: 40, size_bytes: 10, uploaded_at: "2026-01-01", blob_url: "https://x/a.pdf" },
  { id: "2", name: "figures-only.pdf", chunks: 10, size_bytes: 10, uploaded_at: "2026-01-01", blob_url: null },
  { id: "3", name: "neither.pdf", chunks: 5, size_bytes: 10, uploaded_at: "2026-01-01", blob_url: null },
];

console.log("With the index counted:");
{
  const counted = documentEntries(rows, {
    figures: new Map([["has-both.pdf", 7], ["figures-only.pdf", 3]]),
    processes: new Map([["has-both.pdf", 2]]),
  });
  check("reports a document's figures", counted[0].figures === 7, JSON.stringify(counted[0]));
  check("reports a document's processes", counted[0].processes === 2);
  check("a document with figures but no processes reads 0, not null",
    counted[1].figures === 3 && counted[1].processes === 0, JSON.stringify(counted[1]));
  check("a document absent from both maps reads 0, not null",
    counted[2].figures === 0 && counted[2].processes === 0, JSON.stringify(counted[2]));
  check("keeps the existing fields", counted[0].name === "has-both.pdf" && counted[0].chunks === 40);
  check("coalesces a missing blob url to null", counted[1].blobUrl === null);
}

console.log("When the index could not be counted:");
{
  const uncounted = documentEntries(rows, null);
  check("every document still comes back", uncounted.length === 3);
  check("figures read null, NOT 0", uncounted.every((d) => d.figures === null),
    JSON.stringify(uncounted.map((d) => d.figures)));
  check("processes read null, NOT 0", uncounted.every((d) => d.processes === null),
    JSON.stringify(uncounted.map((d) => d.processes)));
  check("the list itself is unaffected", uncounted[0].name === "has-both.pdf" && uncounted[2].chunks === 5);
}

console.log(failures === 0 ? "\nAll kb://documents checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
