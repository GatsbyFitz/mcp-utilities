import { MAX_MERMAID_CHARS } from "./processes";

// ---------------------------------------------------------------------------
// Structural checks on model-authored Mermaid
// ---------------------------------------------------------------------------
// The model writes the diagram; this decides whether it is safe to store.
//
// The failure being guarded against is specific: invalid Mermaid does not throw
// anywhere useful, it renders as an empty frame in the host's iframe with
// nothing saying why. The extraction step feeds these messages straight back to
// the model as a repair request, so each one names what is wrong rather than
// just reporting that something is.
//
// Deliberately conservative — it flags only what it is confident about. A false
// rejection costs a wasted repair round on a diagram that would have rendered,
// which is worse than letting an odd-but-valid diagram through. The real parse
// happens in the browser, where `mermaid.parse()` has a DOM; this runs in a
// workflow step, where it does not.

/** Diagram headers this pipeline expects to produce. */
const HEADERS = /^(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|classDiagram|erDiagram|journey)\b/;

/**
 * Words Mermaid gives its own meaning to. `end` is the one that actually bites:
 * it closes a `subgraph`, so a node called `end` silently swallows the rest of
 * the block. A diagram with two boxes labelled "End" — which is most process
 * diagrams — walks straight into it unless the ids are synthetic.
 */
const RESERVED_IDS = new Set([
  "end", "graph", "subgraph", "flowchart", "click", "style", "classdef",
  "class", "linkstyle", "direction", "state", "note",
]);

/** Arrow forms, used to split a line into the nodes it connects. */
const ARROW = /<?(?:-{2,}|={2,}|-\.-+)[->ox]?/;
const ARROW_G = new RegExp(ARROW.source, "g");

/** An edge label written between pipes, which is text and not structure. */
const PIPE_LABEL = /\|[^|]*\|/g;

const DECLARATION = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[\[|\[\(|\(\(|\[|\(|\{\{|\{|>)/g;

function contentLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("%%"));
}

/** Ids that appear somewhere with a shape, i.e. carry a label. */
function declaredIds(source: string): Set<string> {
  const ids = new Set<string>();
  for (const match of source.matchAll(DECLARATION)) ids.add(match[1]);
  return ids;
}

/** Ids referenced as an endpoint of an edge. */
function edgeEndpoints(lines: string[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    if (/^(subgraph|end|style|classDef|class|click|linkStyle|direction)\b/i.test(line)) continue;
    if (!ARROW.test(line)) continue;

    // Quoted labels go first: a label like "A--B" contains what looks like an
    // arrow, and splitting on it would invent an endpoint that isn't there.
    const structural = line.replace(/"[^"]*"/g, '""').replace(PIPE_LABEL, " ");
    for (const segment of structural.split(ARROW_G)) {
      // `n1["Review Exemption"]` and a bare `n1` both start with the id.
      const head = segment.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (head) ids.push(head[1]);
    }
  }
  return ids;
}

/**
 * Every problem found, or an empty array when the diagram looks sound.
 *
 * Returned as messages rather than codes because their only consumer is the
 * repair prompt, which needs to read them.
 */
export function checkMermaid(source: string): string[] {
  const problems: string[] = [];
  const text = source.trim();

  if (!text) return ["the diagram is empty"];
  if (text.length > MAX_MERMAID_CHARS) {
    problems.push(`the diagram is ${text.length} characters, over the ${MAX_MERMAID_CHARS} limit`);
  }

  const lines = contentLines(text);
  if (lines.length === 0) return ["the diagram has no content"];
  if (!HEADERS.test(lines[0])) {
    problems.push(`the first line must declare a diagram type (e.g. "flowchart TD"), not "${lines[0].slice(0, 40)}"`);
  }

  // Quotes are checked per line: a label left unterminated swallows the rest of
  // that line, and an odd count is the only reliable sign of it.
  for (const [n, line] of lines.entries()) {
    if ((line.match(/"/g) ?? []).length % 2 !== 0) {
      problems.push(`line ${n + 1} has an unclosed double quote: ${line.slice(0, 60)}`);
    }
  }

  for (const [open, close, name] of [["[", "]", "square"], ["(", ")", "round"], ["{", "}", "curly"]] as const) {
    const opened = text.split(open).length - 1;
    const closed = text.split(close).length - 1;
    if (opened !== closed) {
      problems.push(`unbalanced ${name} brackets: ${opened} "${open}" and ${closed} "${close}"`);
    }
  }

  const declared = declaredIds(text);
  for (const id of declared) {
    if (RESERVED_IDS.has(id.toLowerCase())) {
      problems.push(
        `"${id}" is a reserved Mermaid word and cannot be a node id — use a synthetic id such as n1 and put the text in the quoted label`
      );
    }
  }

  // An endpoint that never carries a label renders with its own id as the
  // visible text, which looks like a transcription error rather than a syntax
  // one and is just as wrong.
  const undeclared = [...new Set(edgeEndpoints(lines))].filter((id) => !declared.has(id));
  if (undeclared.length > 0) {
    problems.push(
      `these nodes are used in an edge but never given a label: ${undeclared.join(", ")}`
    );
  }

  return problems;
}

/**
 * The visible text of every node, for the embedding.
 *
 * What someone searches for is the wording on the boxes, so that is what is
 * embedded — the ids are synthetic and carry no meaning by design.
 */
export function nodeLabels(source: string): string[] {
  const labels: string[] = [];
  for (const match of source.matchAll(/(?:\[|\(|\{|>)+\s*"([^"]+)"\s*(?:\]|\)|\})+/g)) {
    labels.push(match[1]);
  }
  // Unquoted labels are legal for simple text, so pick those up too.
  for (const match of source.matchAll(/\[([^\]"|]+)\]/g)) {
    const label = match[1].trim();
    if (label && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) labels.push(label);
  }
  // Edge labels carry the conditions — REJECT, APPROVE — which are exactly the
  // words a question about a process uses.
  for (const match of source.matchAll(/\|\s*"?([^|"]+)"?\s*\|/g)) {
    const label = match[1].trim();
    if (label) labels.push(label);
  }
  return [...new Set(labels.map((l) => l.replace(/&quot;/g, '"').trim()).filter(Boolean))];
}
