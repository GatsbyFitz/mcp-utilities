// Checks the guard that stands between a model-authored diagram and the viewer.
//
// The model writes the Mermaid. That is the design — it is a notation models
// write fluently, and one artifact then serves both the model (which reads the
// source) and the reader (who sees it rendered). The risk it carries is that
// invalid Mermaid fails *silently*: an empty iframe, no error, nothing saying
// why. So every case below is one the extraction step must catch before
// storing, and each message it produces is fed straight back to the model as a
// repair request — which is why they have to name what is wrong.
//
// Offline, no credentials. Run: pnpm verify:processes
import { checkMermaid, nodeLabels } from "@/lib/mermaidCheck";
import { processId, documentOfProcessId, MAX_MERMAID_CHARS } from "@/lib/processes";

let failures = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.error(`  FAIL ${label}${detail ? `\n    ${detail}` : ""}`);
}
const mentions = (problems, text) => problems.some((p) => p.includes(text));

// The real thing: the AEMO exemption life cycle, p6. Two nodes labelled "End",
// which is exactly the case that breaks a naive transcription.
const GOOD = `flowchart TD
  n0(["Start"])
  n1["Create Exemption"]
  n2["Review Exemption"]
  n3["Manage Exemption"]
  n4["Provide More Info"]
  n5(["End"])
  n6(["End"])
  n0 --> n1
  n1 --> n2
  n2 -->|"REJECT"| n5
  n2 -->|"APPROVE"| n3
  n2 -->|"REQUEST MORE INFO"| n4
  n3 -->|"EXPIRE"| n5
  n3 -->|"RESOLVE"| n5
  n3 -->|"CANCEL"| n6
  n4 -->|"CANCEL"| n6
  n4 -->|"SEND FOR REVIEW"| n2
  n3 -->|"REQUEST TO EXTEND"| n2`;

console.log("A valid diagram with two “End” nodes:");
{
  const problems = checkMermaid(GOOD);
  check("passes untouched", problems.length === 0, problems.join("; "));
}

console.log("Cases the guard must catch:");
{
  const p = checkMermaid(`flowchart TD\n  end["End"]\n  n1["Start"] --> end`);
  check("a node id of `end` is rejected by name", mentions(p, "reserved Mermaid word"), p.join("; "));
}
{
  // Quotes balanced, brackets not — so this isolates the bracket rule instead
  // of being caught by the quote one first.
  const p = checkMermaid(`flowchart TD\n  n1["Review final"\n  n1 --> n2["End"]`);
  check("an unbalanced bracket is caught", mentions(p, "unbalanced"), p.join("; "));
}
{
  const p = checkMermaid(`flowchart TD\n  n1["Review Exemption]\n  n1 --> n2["End"]`);
  check("an unclosed quote is caught", mentions(p, "unclosed double quote"), p.join("; "));
}
{
  const p = checkMermaid(`flowchart TD\n  n1["Start"]\n  n1 --> n9`);
  check("an edge to an unlabelled node is caught", mentions(p, "never given a label"), p.join("; "));
}
{
  const p = checkMermaid(`n1["Start"] --> n2["End"]`);
  check("a missing diagram header is caught", mentions(p, "first line must declare"), p.join("; "));
}
{
  const p = checkMermaid(`flowchart TD\n  n1["${"x".repeat(MAX_MERMAID_CHARS)}"]`);
  check("an oversized diagram is caught", mentions(p, "over the"), p.join("; "));
}
{
  check("an empty diagram is caught", checkMermaid("   ").length > 0);
}

console.log("Labels that must NOT be mistaken for syntax:");
{
  const p = checkMermaid(`flowchart TD\n  n1["Retailer --> AEMO"]\n  n2["End"]\n  n1 --> n2`);
  check("an arrow inside a label is not read as an edge", p.length === 0, p.join("; "));
}

console.log("Embedding text:");
{
  const labels = nodeLabels(GOOD);
  check("node labels are picked up", labels.includes("Review Exemption"), labels.join(" | "));
  check("edge conditions are picked up", labels.includes("REQUEST MORE INFO"), labels.join(" | "));
  check("duplicate “End” collapses to one", labels.filter((l) => l === "End").length === 1);
}

console.log("Id namespace:");
{
  const id = processId("report#process.pdf", 3);
  check("round-trips the document name", documentOfProcessId(id) === "report#process.pdf", id);
  check("a figure id is not read as a process", documentOfProcessId("doc.pdf#figure-1") === null);
}

console.log(failures === 0 ? "\nAll process checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
