#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Tool-response QA probe harness
// ---------------------------------------------------------------------------
// verify-mcp-server answers "does the tool respond?". This answers the harder
// question: "is what it responded with good enough for a model to cite?"
//
// Everything here is a *mechanical* check — something with a right answer that
// does not need judgement. The judgement layer (is this excerpt actually
// responsive to the query? is the citation truthful about the document?) lives
// in rubric.md and is done by the model reading this harness's JSON report.
//
// The renderers in app/mcp/tools/ are the contract: this file parses the text
// block back apart and asserts it agrees with structuredContent. The text block
// is what the model cites (see .claude/rules/mcp-tools.md), so a defect that
// exists only in the text is still a real defect.
//
// Usage:
//   node .claude/skills/qa-tool-responses/probe.mjs [--base URL] [--out FILE]
//                                                   [--probes FILE] [--quick]
// Env: QA_MCP_BASE overrides --base.
// Exit code is 1 if any check fails, 0 otherwise (warnings do not fail a run).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  base: process.env.QA_MCP_BASE ?? "https://mcp-utilities.vercel.app/mcp",
  out: "/tmp/qa-tool-responses.json",
  probes: path.join(HERE, "probes.json"),
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
// mcp-handler speaks Streamable HTTP: the reply to a plain POST is usually an
// SSE frame, not bare JSON. The deployed instance is stateless (no
// mcp-session-id header at all); a local `pnpm dev` instance is not. Capture
// the header when it is offered and echo it back when it exists, so the same
// harness works against both without a flag.

function parseBody(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .join("");
  if (!data) throw new Error(`unparseable body: ${trimmed.slice(0, 200)}`);
  return JSON.parse(data);
}

class Client {
  constructor(base) {
    this.base = base;
    this.sessionId = null;
  }

  async send(body, { timeoutMs = 120_000 } = {}) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const started = Date.now();
    const res = await fetch(this.base, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    const raw = await res.text();
    return { http: res.status, ms: Date.now() - started, json: parseBody(raw) };
  }

  async initialize() {
    const { json } = await this.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "qa-tool-responses", version: "1.0.0" },
      },
    });
    if (json.error) throw new Error(`initialize failed: ${JSON.stringify(json.error)}`);
    // Protocol says the client must confirm; mcp-handler tolerates its absence,
    // but a 202 here costs nothing and keeps a stricter server happy.
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
    return json.result;
  }

  callTool(id, name, args, opts) {
    return this.send(
      { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
      opts
    );
  }

  readResource(id, uri) {
    return this.send({ jsonrpc: "2.0", id, method: "resources/read", params: { uri } });
  }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
// fail  = the response violates a stated contract in .claude/rules/mcp-tools.md
//         or is internally inconsistent. Always actionable.
// warn  = the response is well-formed but degraded in a way that costs the
//         model citation quality. Needs a human/model judgement call.
// info  = a measurement carried into the report for the rubric to weigh.

const F = (level) => (check, message, evidence) => ({ level, check, message, evidence });
const fail = F("fail");
const warn = F("warn");
const info = F("info");

const PLACEHOLDER = /\b(undefined|NaN)\b|\[object Object\]|\bnull\b(?!\s*URL)/;
const STACK_LEAK = /\/(var|home|usr|opt|task)\/|\bat [A-Za-z0-9_$.]+ \(|node_modules/;

function estTokens(text) {
  return Math.round(text.length / 4);
}

/** Header emitted by citationLine(): "[1] Title (v2.0, pp. 3-4) — relevance 0.89" */
const DOC_HEADER = /^\[(\d+)\] (.+?) — relevance (\d+\.\d+)$/gm;
/** Header emitted by pathLine(): "[R1] A —RELTYPE→ B (source.pdf)" */
const REL_HEADER = /^\[R(\d+)\] (.+?) —(.+?)→ (.+?) \((.+?)\)$/gm;

/**
 * Segment a rendered block by its citation headers. Splitting on the "---"
 * separator would be wrong: chunk text is Markdown and can contain a rule of
 * its own (several chunks in the live corpus do).
 */
function segmentByHeader(text, regex) {
  const re = new RegExp(regex.source, regex.flags);
  const hits = [...text.matchAll(re)];
  return hits.map((m, i) => {
    const bodyStart = m.index + m[0].length;
    const bodyEnd = i + 1 < hits.length ? hits[i + 1].index : text.length;
    return {
      n: Number(m[1]),
      groups: m.slice(2),
      header: m[0],
      body: text.slice(bodyStart, bodyEnd).replace(/\n---\n/g, "\n").trim(),
    };
  });
}

/** Split "…\n\nSources:\n- a: url" into [everything before, the source lines]. */
function splitSources(text) {
  const at = text.lastIndexOf("\n\nSources:\n");
  if (at === -1) return { body: text, sources: null };
  return {
    body: text.slice(0, at),
    sources: text
      .slice(at + "\n\nSources:\n".length)
      .split("\n")
      .filter((l) => l.startsWith("- ")),
  };
}

function checkNumbering(ns, label) {
  const out = [];
  const expected = ns.map((_, i) => i + 1);
  if (ns.length && ns.join(",") !== expected.join(",")) {
    out.push(
      fail(
        `${label}.numbering`,
        `${label} citation numbers are not contiguous from 1 — a model citing "[3]" may be pointing at nothing`,
        { got: ns, expected }
      )
    );
  }
  return out;
}

/** Shared across both tools: the deduplicated "Sources:" block. */
function checkSources(sources, citations, label) {
  const out = [];
  if (sources === null) {
    out.push(fail(`${label}.sources-section`, "response has no `Sources:` section"));
    return out;
  }
  const distinct = new Set(citations.map((c) => c.source));
  if (sources.length !== distinct.size) {
    out.push(
      fail(
        `${label}.sources-dedup`,
        `Sources list has ${sources.length} lines for ${distinct.size} distinct documents — each document's URL must appear exactly once`,
        { lines: sources, distinct: [...distinct] }
      )
    );
  }
  for (const line of sources) {
    const url = line.slice(line.lastIndexOf(": ") + 2);
    const ok = /^https?:\/\/\S+$/.test(url) || url === "no URL in index";
    if (!ok) {
      out.push(
        fail(
          `${label}.url-shape`,
          "a source line carries neither a real URL nor the literal `no URL in index`; the tool description forbids inventing one",
          { line }
        )
      );
    }
  }
  return out;
}

function checkHygiene(text, label) {
  const out = [];
  const hit = text.match(PLACEHOLDER);
  if (hit) {
    out.push(
      fail(`${label}.placeholder-leak`, `rendered text leaks a placeholder value (${hit[0]})`, {
        context: text.slice(Math.max(0, hit.index - 90), hit.index + 90),
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Graders (exported so they can be exercised against fixtures)
// ---------------------------------------------------------------------------

export function gradeEnvelope(probe, json, budget) {
  const out = [];
  const wantsRejection = probe.expect === "rejected";

  if (json.error) {
    if (!wantsRejection) {
      out.push(fail("envelope.rpc-error", "unexpected JSON-RPC error", json.error));
    } else if (STACK_LEAK.test(JSON.stringify(json.error))) {
      out.push(warn("validation.error-hygiene", "rejection leaks a stack frame or server path to the client", json.error));
    }
    return out;
  }

  const result = json.result ?? {};
  const text = result.content?.[0]?.text ?? "";

  // A schema rejection is a *correct* outcome for the malformed-argument
  // probes. mcp-handler surfaces it as `isError: true` with a message naming
  // the offending field rather than as a JSON-RPC error object; both count.
  // What must never happen is the call succeeding — maxHops in particular is
  // interpolated into Cypher, so the schema is the only thing guarding it.
  if (wantsRejection) {
    if (!result.isError) {
      out.push(
        fail(
          "validation.rejects-invalid",
          "out-of-range arguments were accepted instead of rejected — the input schema is not being enforced",
          { arguments: probe.arguments, text: text.slice(0, 200) }
        )
      );
    } else if (!/invalid|validation/i.test(text)) {
      out.push(warn("validation.error-message", "the argument was rejected, but the message does not identify which one or why", { text }));
    } else {
      out.push(info("validation.rejected", "out-of-range argument correctly rejected", { text }));
    }
    if (STACK_LEAK.test(text)) {
      out.push(warn("validation.error-hygiene", "rejection message leaks a stack frame or server path", { text }));
    }
    return out;
  }

  if (!result.content?.[0] || result.content[0].type !== "text" || !text.trim()) {
    out.push(fail("envelope.text-block", "no non-empty text content block; there is nothing for a model to read or cite"));
    return out;
  }
  if (result.isError) {
    out.push(fail("envelope.tool-error", "tool returned isError", { text }));
    if (/^\s*\w+ failed:\s*$/.test(text) || text.length < 20) {
      out.push(fail("envelope.error-message", "isError response carries no real message", { text }));
    }
    if (STACK_LEAK.test(text)) {
      out.push(warn("envelope.error-hygiene", "error message leaks a stack frame or server path", { text }));
    }
    return out;
  }
  if (probe.tool !== "echo" && !result.structuredContent) {
    out.push(
      fail(
        "envelope.structured",
        "search tool returned no structuredContent; mcp-tools.md requires both a text block and structuredContent"
      )
    );
  }

  const bytes = text.length;
  out.push(info("response.size", `${bytes} bytes (~${estTokens(text)} tokens)`, { bytes }));
  if (bytes > budget.maxTextBytes) {
    out.push(
      warn(
        "response.size-budget",
        `text block is ${bytes} bytes (~${estTokens(text)} tokens), over the ${budget.maxTextBytes}-byte budget — oversized results crowd out the model's own reasoning and degrade citation accuracy`,
        { bytes, budget: budget.maxTextBytes }
      )
    );
  }
  return out;
}

export function gradeSearchDocs(probe, result, budget) {
  const out = [];
  const text = result.content[0].text;
  const sc = result.structuredContent ?? {};
  const results = sc.results ?? [];

  out.push(...checkHygiene(text, "docs"));

  if (results.length === 0) {
    const empty = /^No matching chunks found for/.test(text);
    if (!empty) {
      out.push(fail("empty.message", "zero results but the text does not say so plainly", { text: text.slice(0, 200) }));
    }
    // mcp-tools.md: "Handle the empty case explicitly with a message that says
    // what the index covers and suggests the sibling tool."
    if (!/search_graph/.test(text)) {
      out.push(
        fail(
          "empty.guidance",
          "empty-result message names neither what the index covers nor the sibling tool (search_graph), so the model has no next move",
          { text }
        )
      );
    }
    return out;
  }

  const claimed = Number(text.match(/^Found (\d+) matching chunks/)?.[1] ?? NaN);
  const segments = segmentByHeader(splitSources(text).body, DOC_HEADER);
  if (!(claimed === results.length && segments.length === results.length)) {
    out.push(
      fail(
        "docs.count-agreement",
        `the header count, the rendered result count and structuredContent disagree`,
        { claimed, rendered: segments.length, structured: results.length }
      )
    );
  }
  out.push(...checkNumbering(segments.map((s) => s.n), "docs"));

  for (const seg of segments) {
    if (!seg.body) {
      out.push(
        fail("docs.excerpt-nonempty", `result [${seg.n}] renders a citation header with an empty body`, {
          header: seg.header,
        })
      );
    }
  }

  const topN = probe.arguments.topN ?? 8;
  if (results.length > topN) {
    out.push(fail("docs.topn-honored", `topN=${topN} but ${results.length} results were returned`));
  }

  const scores = results.map((r) => r.score);
  if (scores.some((s, i) => i > 0 && s > scores[i - 1] + 1e-9)) {
    out.push(fail("docs.score-order", "rerank scores are not monotonically decreasing; [1] is not the best match", { scores }));
  }
  if (scores.length && scores[0] < budget.minTopScore) {
    out.push(
      warn(
        "docs.score-floor",
        `top rerank score is ${scores[0].toFixed(2)}, below the ${budget.minTopScore} floor — the tool still announces "Found N matching chunks", presenting weak matches with unearned confidence`,
        { query: probe.arguments.query, scores }
      )
    );
  }

  if (probe.expect === "empty" && results.length) {
    out.push(
      fail(
        "docs.relevance-floor",
        `an off-corpus query returned ${results.length} "matching chunks" (top rerank score ${scores[0]?.toFixed(3)}) instead of nothing — search_docs applies no relevance floor, so a model asking something the corpus cannot answer is handed unrelated text framed as a match`,
        { query: probe.arguments.query, scores, sources: [...new Set(results.map((r) => r.citation.source))] }
      )
    );
  }

  const ids = results.map((r) => r.id);
  if (new Set(ids).size !== ids.length) {
    out.push(warn("docs.duplicate-chunks", "the same chunk was returned more than once", { ids }));
  }

  // createEmbeddings writes id = chunkId(fileName, i) and metadata
  // {source: fileName, chunkIndex: i}. If those ever disagree, the chunking
  // invariant in lib/chunking.ts has drifted and graph excerpts break silently.
  for (const r of results) {
    const expected = `${r.citation.source}-${r.citation.chunkIndex}`;
    if (r.id !== expected) {
      out.push(
        fail(
          "docs.chunk-id-invariant",
          `chunk id does not match \`\${source}-\${chunkIndex}\`; lib/chunking.ts and the stored index have drifted`,
          { id: r.id, expected }
        )
      );
    }
  }

  const citations = results.map((r) => r.citation);
  out.push(...checkSources(splitSources(text).sources, citations, "docs"));

  const noPages = citations.filter((c) => !c.pages).length;
  if (noPages) {
    out.push(
      (noPages === citations.length ? fail : warn)(
        "docs.page-coverage",
        `${noPages}/${citations.length} citations carry no page range, yet the tool description instructs the model to cite one — it cannot, so it will either omit or invent it`,
        { noPages, total: citations.length }
      )
    );
  }
  const noVersion = citations.filter((c) => !c.version).length;
  if (noVersion) {
    out.push(
      warn(
        "docs.version-coverage",
        `${noVersion}/${citations.length} citations carry no version, yet the tool description instructs the model to cite one`,
        { noVersion, total: citations.length }
      )
    );
  }

  for (const c of citations) {
    out.push(...gradeTitle(c, "docs"));
  }
  return out;
}

/**
 * A citation title is the load-bearing part of the citation: it is what a
 * reader sees and what they use to find the document. extractTitle() takes the
 * markdown's first H1, which is frequently a running header rather than the
 * document's name, so this is a live failure mode rather than a theoretical one.
 */
export function gradeTitle(c, label) {
  const out = [];
  const title = c.title ?? "";
  if (!title.trim()) {
    out.push(fail(`${label}.title-empty`, "citation has no title", c));
    return out;
  }
  if (/[:;,\-–—]\s*$/.test(title)) {
    out.push(
      warn(
        `${label}.title-truncated`,
        `citation title "${title}" ends in punctuation, so it is a cut-off running header rather than the document's name`,
        c
      )
    );
  }
  const stem = (c.source ?? "").replace(/\.[a-z0-9]+$/i, "");
  const words = (s) => new Set(s.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const titleWords = words(title);
  const stemWords = words(stem.replace(/[-_]+/g, " "));
  const overlap = [...titleWords].filter((w) => stemWords.has(w)).length;
  // A filename is often the title's acronym (NERR - v30 - Full.pdf ->
  // "National Energy Retail Rules"), which shares no whole words with it but
  // is a perfectly good title. Treat that as agreement, not drift.
  const initials = (title.match(/\b[A-Za-z]/g) ?? []).join("").toLowerCase();
  const compactStem = stem.toLowerCase().replace(/[^a-z]/g, "");
  const acronymMatch = initials.length >= 3 && compactStem.includes(initials);
  if (stemWords.size && titleWords.size && overlap === 0 && !acronymMatch) {
    out.push(
      warn(
        `${label}.title-source-mismatch`,
        `citation title "${title}" shares no words with its filename "${c.source}" — the model will cite a document name that does not identify the file it came from`,
        c
      )
    );
  }
  return out;
}

export function gradeSearchGraph(probe, result, budget) {
  const out = [];
  const text = result.content[0].text;
  const sc = result.structuredContent ?? {};
  const relations = sc.relations ?? [];
  const excerpts = sc.excerpts ?? [];

  out.push(...checkHygiene(text, "graph"));

  if (relations.length === 0) {
    if (!/No graph matches for/.test(text)) {
      out.push(fail("empty.message", "zero relations but the text does not say so plainly", { text: text.slice(0, 200) }));
    }
    if (!/search_docs/.test(text)) {
      out.push(fail("empty.guidance", "empty-result message does not point at the sibling tool", { text }));
    }
    return out;
  }

  if (probe.expect === "empty") {
    out.push(
      fail(
        "graph.similarity-floor",
        `an off-corpus query returned ${relations.length} relationship(s) instead of nothing — the \`score > 0.6\` seed floor in the Cypher did not hold, so search_graph will answer questions its corpus knows nothing about`,
        { query: probe.arguments.query, sample: relations.slice(0, 3) }
      )
    );
  }

  const claimed = Number(text.match(/^Found (\d+) relationship\(s\)/)?.[1] ?? NaN);
  const paths = segmentByHeader(text, REL_HEADER);
  if (!(claimed === relations.length && paths.length === relations.length)) {
    out.push(
      fail("graph.count-agreement", "relationship counts disagree between header, rendering and structuredContent", {
        claimed,
        rendered: paths.length,
        structured: relations.length,
      })
    );
  }
  out.push(...checkNumbering(paths.map((p) => p.n), "graph.rel"));

  for (const [i, r] of relations.entries()) {
    if (!r.description?.trim()) {
      out.push(fail("graph.rel-description", `relationship [R${i + 1}] has an empty description, rendering as a bare edge`, r));
    }
    if (r.source === r.target) {
      out.push(warn("graph.self-loop", `relationship [R${i + 1}] points an entity at itself`, r));
    }
    // extractGraph writes chunkId: chunkId(fileName, i) and sourceDoc: fileName
    // together. A mismatch means the chunkId cannot round-trip to a real vector.
    if (!(typeof r.chunkId === "string" && r.chunkId.startsWith(`${r.sourceDoc}-`) && /-\d+$/.test(r.chunkId))) {
      out.push(
        fail(
          "graph.chunkid-invariant",
          `relationship chunkId "${r.chunkId}" is not \`\${sourceDoc}-\${index}\`; it cannot round-trip through vectorIndex.fetch()`,
          r
        )
      );
    }
    if (probe.arguments.maxHops && r.hops > probe.arguments.maxHops) {
      out.push(fail("graph.hops-clamp", `relationship reports ${r.hops} hops, over the requested maxHops`, r));
    }
  }

  // The renderer numbers excerpts by their index in the *fetched* array, then
  // drops entries with no metadata — so a chunkId that no longer resolves both
  // loses an excerpt and leaves a hole in the numbering.
  out.push(...checkNumbering(excerpts.map((e) => e.n), "graph.excerpt"));

  const maxChunks = probe.arguments.maxChunks ?? 5;
  const requested = Math.min(new Set(relations.map((r) => r.chunkId)).size, maxChunks);
  if (excerpts.length < requested) {
    out.push(
      fail(
        "graph.chunk-roundtrip",
        `${requested - excerpts.length} of ${requested} chunkIds did not resolve to a chunk in the vector index — the graph and the vector index have drifted apart (see the chunking invariant in ingestion-pipeline.md)`,
        { requested, resolved: excerpts.length }
      )
    );
  }

  const scored = segmentByHeader(text, DOC_HEADER);
  if (scored.length && scored.every((s) => s.groups[1] === "1.00")) {
    out.push(
      warn(
        "graph.fabricated-score",
        "every supporting excerpt renders `relevance 1.00`; graph excerpts carry no similarity score, so the header states a confidence the tool never measured",
        { count: scored.length }
      )
    );
  }
  for (const seg of scored) {
    if (!seg.body) {
      out.push(fail("graph.excerpt-nonempty", `excerpt [${seg.n}] has an empty body`, { header: seg.header }));
    }
  }

  for (const e of excerpts) {
    const wordCount = (e.text ?? "").split(/\s+/).filter(Boolean).length;
    if (wordCount < 25 || /Prepared by:|Approved for distribution|Approved by:/.test(e.text ?? "")) {
      out.push(
        warn(
          "graph.excerpt-substance",
          `excerpt [${e.n}] looks like cover-page or front-matter boilerplate rather than supporting evidence`,
          { id: e.id, preview: (e.text ?? "").slice(0, 160) }
        )
      );
    }
    out.push(...gradeTitle(e.citation, "graph"));
  }

  out.push(...checkSources(splitSources(text).sources, excerpts.map((e) => e.citation), "graph"));

  if (relations.length >= budget.relationCap) {
    out.push(
      warn(
        "graph.rel-volume",
        `${relations.length} relationships returned (the Cypher LIMIT), ordered only by hop distance — the model must read every one to find the relevant edge`,
        { count: relations.length }
      )
    );
  }
  return out;
}

/** Cross-probe invariants: things only visible across two or more responses. */
export function gradeConsistency(runs) {
  const out = [];

  const titles = new Map();
  for (const run of runs) {
    for (const c of run.citations ?? []) {
      if (!titles.has(c.source)) titles.set(c.source, new Set());
      titles.get(c.source).add(c.title);
    }
  }
  for (const [source, set] of titles) {
    if (set.size > 1) {
      out.push(
        fail(
          "consistency.title-per-source",
          `document "${source}" is cited under ${set.size} different titles across probes, so the same source looks like several documents`,
          { source, titles: [...set] }
        )
      );
    }
  }

  const byPair = new Map();
  for (const run of runs) {
    if (!run.determinismKey) continue;
    if (!byPair.has(run.determinismKey)) byPair.set(run.determinismKey, []);
    byPair.get(run.determinismKey).push(run);
  }
  for (const [key, pair] of byPair) {
    if (pair.length < 2) continue;
    const [a, b] = pair;
    const ida = (a.ids ?? []).join(",");
    const idb = (b.ids ?? []).join(",");
    if (ida !== idb) {
      out.push(
        warn(
          "consistency.determinism",
          `the identical query returned a different result ordering on a repeat call; retrieval is not stable, so an answer is not reproducible`,
          { key, first: a.ids, second: b.ids }
        )
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Probe construction
// ---------------------------------------------------------------------------
// Curated probes come from probes.json. Per-document probes are derived at run
// time from kb://documents so that coverage follows whatever is actually
// ingested instead of rotting against a hard-coded corpus.

function queryFromFilename(name) {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\bv\d+[a-z]?\d*\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function buildProbes(client, config, quick) {
  const probes = config.probes.filter((p) => !quick || p.quick !== false);

  let documents = [];
  try {
    const { json } = await client.readResource(90, "kb://documents");
    documents = JSON.parse(json.result.contents[0].text).documents ?? [];
  } catch (err) {
    return { probes, documents, docError: String(err) };
  }

  const perDoc = documents.slice(0, quick ? 1 : config.maxDocumentProbes ?? 4);
  for (const doc of perDoc) {
    const query = queryFromFilename(doc.name);
    if (query.length < 2) continue;
    probes.push({
      id: `docs-corpus-${doc.name}`,
      tool: "search_docs",
      arguments: { query, topK: 20, topN: 4 },
      expect: "results",
      note: `derived from an indexed document (${doc.chunks} chunks); this document must be findable by its own name`,
      mustCite: doc.name,
    });
  }
  return { probes, documents };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { ...DEFAULTS, quick: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quick") args.quick = true;
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--probes") args.probes = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(args.probes, "utf8"));
  const budget = config.budget;

  const client = new Client(args.base);
  const serverInfo = await client.initialize();
  const { probes, documents, docError } = await buildProbes(client, config, args.quick);

  const report = {
    startedAt: new Date().toISOString(),
    base: args.base,
    serverInfo,
    documents: documents.map((d) => ({ name: d.name, chunks: d.chunks })),
    probes: [],
    findings: [],
  };
  if (docError) {
    report.findings.push(fail("corpus.unreadable", "kb://documents could not be read, so probes could not be grounded in the live corpus", { error: docError }));
  }

  const runs = [];
  let id = 100;

  for (const probe of probes) {
    process.stderr.write(`· ${probe.id} … `);
    const entry = { ...probe, findings: [] };
    let json, ms;
    try {
      ({ json, ms } = await client.callTool(id++, probe.tool, probe.arguments));
    } catch (err) {
      entry.findings.push(fail("envelope.transport", `request failed: ${err.message}`));
      report.probes.push(entry);
      process.stderr.write("TRANSPORT FAIL\n");
      continue;
    }
    entry.ms = ms;

    entry.findings.push(...gradeEnvelope(probe, json, budget));
    const result = json.result;
    if (result && !result.isError && result.content?.[0]?.text) {
      if (probe.tool === "search_docs") entry.findings.push(...gradeSearchDocs(probe, result, budget));
      if (probe.tool === "search_graph") entry.findings.push(...gradeSearchGraph(probe, result, budget));

      const sc = result.structuredContent ?? {};
      const citations = [
        ...(sc.results ?? []).map((r) => r.citation),
        ...(sc.excerpts ?? []).map((e) => e.citation),
      ];
      const ids = (sc.results ?? []).map((r) => r.id);
      runs.push({ probe: probe.id, citations, ids, determinismKey: probe.determinismKey });

      // A probe derived from a real document must retrieve that document.
      if (probe.mustCite && citations.length && !citations.some((c) => c.source === probe.mustCite)) {
        entry.findings.push(
          fail(
            "docs.self-retrieval",
            `a query built from "${probe.mustCite}" did not retrieve that document at all — it is indexed but not reachable`,
            { query: probe.arguments.query, retrieved: [...new Set(citations.map((c) => c.source))] }
          )
        );
      }

      // Carried into the report so the rubric's judgement pass has the actual
      // prose to read, not just counts.
      entry.text = result.content[0].text;
      entry.structuredContent = sc;
    }

    const bad = entry.findings.filter((f) => f.level === "fail").length;
    process.stderr.write(bad ? `${bad} FAIL (${ms}ms)\n` : `ok (${ms}ms)\n`);
    report.probes.push(entry);
  }

  report.findings.push(...gradeConsistency(runs));
  report.finishedAt = new Date().toISOString();

  const all = [...report.findings, ...report.probes.flatMap((p) => p.findings)];
  report.summary = {
    probes: report.probes.length,
    fail: all.filter((f) => f.level === "fail").length,
    warn: all.filter((f) => f.level === "warn").length,
    byCheck: Object.fromEntries(
      Object.entries(
        all
          .filter((f) => f.level !== "info")
          .reduce((acc, f) => ({ ...acc, [f.check]: (acc[f.check] ?? 0) + 1 }), {})
      ).sort((a, b) => b[1] - a[1])
    ),
  };

  await writeFile(args.out, JSON.stringify(report, null, 2));

  console.log(`\n${report.summary.fail} fail · ${report.summary.warn} warn · ${report.probes.length} probes`);
  for (const [check, n] of Object.entries(report.summary.byCheck)) {
    const level = all.find((f) => f.check === check).level;
    console.log(`  ${level === "fail" ? "FAIL" : "warn"}  ${check} ×${n}`);
  }
  console.log(`\nfull report: ${args.out}`);
  process.exit(report.summary.fail > 0 ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`probe harness crashed: ${err.stack ?? err}`);
    process.exit(2);
  });
}
