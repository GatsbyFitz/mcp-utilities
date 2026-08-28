---
name: qa-tool-responses
description: In-depth quality assurance of what the MCP tools actually return — citation accuracy, retrieval relevance, response hygiene — as opposed to whether they respond at all. Use when asked to "QA the tool responses", "check output quality", "audit citations", or when the daily tool-response QA routine fires. Runs a probe harness against a live server, grades the results against a rubric, and files findings.
---

# QA tool responses

`verify-mcp-server` answers *does the tool respond?* This answers the question that actually decides whether the server is useful: **is what it returned good enough for a model to cite?**

Those fail differently. Every check in `verify-mcp-server` can pass while `search_docs` returns three unrelated chunks under a confident "Found 3 matching chunks" header, attributed to a document title that isn't the document's name. Nothing throws. Nothing is `isError`. The response is well-formed and wrong, and the model downstream cites it.

This routine runs in two layers:

1. **Mechanical** — [probe.mjs](probe.mjs) asserts everything with a right answer: contract conformance, citation-scaffolding integrity, index invariants, schema enforcement. No judgement needed.
2. **Judgement** — you read the prose the harness captured and grade it against [rubric.md](rubric.md). Is this excerpt *responsive*? Does this citation *identify the real document*? The harness can't answer those.

Both matter. The mechanical layer alone passes a response that is structurally perfect and substantively useless.

## Target

Default is the deployed instance, `https://mcp-utilities.vercel.app/mcp` — the surface real clients actually call, and the only one reachable from a fresh scheduled session (a local `pnpm dev` needs `.env.local`, which is gitignored and absent in a clean container).

The harness handles both transports: the deployed instance is stateless, a local one issues an `mcp-session-id`, and it echoes the header only when offered. To QA local edits instead:

```bash
pnpm dev &                                    # needs .env.local
node .claude/skills/qa-tool-responses/probe.mjs --base http://localhost:3000/mcp
```

## Steps

**1. Run the harness.**

```bash
node .claude/skills/qa-tool-responses/probe.mjs --out /tmp/qa-tool-responses.json
```

It reads `kb://documents` first and derives a probe per indexed document, so coverage follows whatever is actually ingested rather than a hard-coded corpus. Curated probes — exact-term retrieval, the off-corpus case, schema enforcement, a repeat call for determinism — live in [probes.json](probes.json). Add `--quick` for a ~8-probe smoke pass, `--base` to retarget.

Exit code is 1 if anything failed. Findings are levelled:

- **fail** — a stated contract in [mcp-tools.md](../../rules/mcp-tools.md) is violated, or the response contradicts itself. Always actionable.
- **warn** — well-formed but degraded in a way that costs citation quality. Needs your judgement.
- **info** — a measurement carried into the report for the rubric to weigh.

**2. Read the report, not just the summary.** `/tmp/qa-tool-responses.json` carries the full `text` and `structuredContent` of every probe. The counts tell you where to look; the prose is what you are grading. A single underlying defect shows up once per citation — twelve `title-truncated` findings are usually *one* bad document title, not twelve problems. Group by root cause before reporting.

**3. Grade against [rubric.md](rubric.md).** Work its dimensions in order. This is the half that catches what no assertion can: an excerpt that is on-topic but doesn't answer the question, a relationship that is true but trivial, a citation that is well-formed and points at the wrong document. Spot-check at least one citation against the actual source PDF via its `blobUrl` — the citation claim is the one thing the harness has no way to verify.

**4. Report.** See [rubric.md](rubric.md) for the verdict format and the issue-filing rules.

## Interpreting failures

- `docs.chunk-id-invariant` / `graph.chunkid-invariant` / `graph.chunk-roundtrip` — the chunking invariant has broken. `lib/chunking.ts` is the single source of truth for both `createEmbeddings` and `extractGraph`; if they disagree, every graph excerpt fetches a wrong or missing chunk. See [ingestion-pipeline.md](../../conventions/ingestion-pipeline.md). Needs a re-ingest, not a code tweak.
- `docs.relevance-floor` / `graph.similarity-floor` — the tool answered a question the corpus cannot answer. This is a *retrieval design* finding, not a bug report: neither tool has a score floor, so they always return their top-k. Fixing it means deciding a threshold, which is a product call — raise it, don't silently patch it.
- `docs.self-retrieval` — a document is indexed but a query built from its own name doesn't retrieve it. Embedding drift or a failed ingest; cross-check with `/check-embedding-integrity`.
- `docs.page-coverage` — `pageRange()` in [citations.ts](../../../lib/citations.ts) looks for `Page (N) Break` markers in chunk text. If no chunk has them, the PDF→Markdown step stopped emitting them and every citation lost its page range while the tool description still instructs the model to cite one.
- `validation.rejects-invalid` — the input schema is not being enforced. Urgent for `maxHops`: it is interpolated into the Cypher string, and the schema clamp is the only thing guarding it.
- Anything under `envelope.*` — the response shape itself is broken; run `/verify-mcp-server` first, since this routine is grading output that may not be worth grading yet.
