# Rubric: grading tool-response quality

The harness has already checked everything with a right answer. What is left is the part that decides whether the server is actually useful, and it needs reading rather than asserting.

Grade from the report's captured `text` — that is what the model sees and cites. `structuredContent` is a cross-check, not the artefact under review ([mcp-tools.md](../../rules/mcp-tools.md): the text block is what gets cited).

Sample deliberately: every probe's `[1]`, plus any result the harness flagged, plus at least one full response read end to end. Skimming sixteen responses finds less than reading three.

## A. Responsiveness — does `[1]` answer the question?

The top result carries the most weight; a model rarely reads past the first two or three. For each probe ask: if I had only this response, could I answer the query correctly and completely?

Distinguish three failure modes, because they have different fixes:

- **Off-topic** — unrelated to the query. Retrieval failure; check embeddings.
- **On-topic but not responsive** — the right subject, but it doesn't answer the question. `"who must provide standing data"` returning a *definition* of standing data rather than the obligation clause. Usually a chunking or reranking issue.
- **Responsive but partial** — the answer is split across a chunk boundary and only half is here. A chunking-size issue; note which document and where it split.

## B. Citation truthfulness — the one thing no assertion can verify

A citation is a factual claim about a document. Pick at least one per run and check it against the real PDF via the `blobUrl` in the report:

- Does the **title** identify the document a reader would go looking for? `extractTitle()` takes the markdown's first H1, which is often a running header or a cross-reference to *another* document, not this one's name.
- If a **page range** is present, does the quoted text appear on that page? `pageRange()` reports `min+1` for a single page but `max+2` for a range — an asymmetry worth confirming against a real PDF rather than assuming.
- Does the **URL** resolve, and to that document?

A confidently-worded citation pointing at the wrong document is worse than no citation: it is unfalsifiable-looking and a reader will trust it.

## C. Excerpt integrity

- Is the excerpt cut mid-sentence, mid-row, or mid-table? `chunkText()` splits on Markdown block boundaries and never splits a table, so a broken table means the invariant is not holding.
- Does the chunk carry its own heading context, or does it open on a bare `| Yes | No |` with nothing saying what the table is?
- Is it front matter — cover page, approval block, table of contents — dressed up as evidence? The harness flags the obvious cases (`graph.excerpt-substance`); judge the rest.

## D. Ranking honesty

Scores are rendered into the header the model reads, so they are part of the response, not metadata.

- Do the rerank scores track your own sense of relevance? A `0.89` on something mediocre means the header is overstating confidence.
- Is `[1]` genuinely the best of what came back?
- Are there near-duplicate chunks occupying several slots — the same content indexed twice, crowding out coverage?

## E. Graph edge quality

- Is each relationship **grounded in its excerpt**, or did extraction hallucinate a plausible-sounding edge? Read the `description` against the chunk it cites.
- Is it **substantive**? Thirty `X —CONSTITUTES→ Y` edges enumerating a schema's fields are technically correct and answer nothing.
- Do the returned relations actually bear on the query? Relations come back ordered by hop distance, not relevance — so judge whether the *first few* earn their place, since that is what gets read.

## F. Tool steering

The two descriptions are supposed to divide the work: `search_docs` for direct lookups, `search_graph` for relational questions. Compare the two responses to the same relational query in the report. If `search_docs` answers a relational question better than `search_graph` does, the descriptions are steering the model wrong — and that is a defect in the *descriptions*, which must be updated together.

## G. Token economy

Note any response over the byte budget. A 13KB response for `topN: 3` is one wide table crowding out the model's own reasoning. Quality is not just accuracy; a correct answer buried in 4,000 tokens of table markup degrades what the model does with it.

---

## Verdict

State one line per dimension: **sound** / **degraded** / **broken**, each with the specific probe and citation that justifies it. A verdict with no evidence attached is not a verdict.

Then an overall call:

- **Ship** — no fail-level findings, warnings all known and accepted.
- **Ship with caveats** — degraded quality that does not mislead. Name what a user should not trust.
- **Hold** — any finding where a model would cite something false: wrong document identity, fabricated confidence, a broken chunk round-trip.

## Known defects

Baseline from the first full run against the deployed instance. These are **known**, so report them as *still present*, never as new regressions. Anything not on this list that reaches fail level is a genuine regression and should say so loudly.

| Finding | What it is |
| --- | --- |
| `docs.relevance-floor`, `graph.similarity-floor` | Neither tool has a relevance floor. An off-corpus query ("sourdough starter hydration ratios") returns "Found 3 matching chunks" at rerank score 0.02, and "Found 30 relationship(s)". Product decision, not a bug. |
| `docs.page-coverage` | No chunk carries `Page (N) Break` markers, so every citation lacks a page range — while both tool descriptions instruct the model to cite one. |
| `docs.version-coverage` | `createEmbeddings` never writes `version` metadata, so `citation.version` is always null despite the descriptions promising it. |
| `docs.title-truncated`, `docs.title-source-mismatch` | `nmi-standing-data-schedule-v12.pdf` is titled `"MSATS Procedures:"` — a truncated running header naming a different document. Renders a double colon in the Sources list. |
| `graph.fabricated-score` | Graph excerpts have no similarity score, so `citationLine` is passed a hardcoded `1.0` and every excerpt claims `relevance 1.00`. |
| `graph.rel-volume` | The Cypher `LIMIT 30` is routinely hit, and relations are ordered by hop distance rather than relevance. |
| `response.size-budget` | Wide tables push single responses past 24KB. |

Keep this table current: when a defect is fixed, delete its row in the same change, so a reappearance is caught as a regression rather than silently matching the baseline.

## Filing findings

One tracking issue, not one per run. Title: **`MCP tool-response QA`**.

- **Clean run** (no fail-level findings, nothing new) — file nothing, comment nothing. Silence is the signal.
- **Failures or new regressions** — find the open issue by that title in `gatsbyfitz/mcp-utilities` and add a comment; create the issue only if none is open. Edit the issue body to reflect current state so it reads as live status rather than an append-only log.

The comment carries: run timestamp and target, the `N fail / M warn` summary, each finding **grouped by root cause** (not one bullet per occurrence) with the probe and quoted evidence, your dimension verdicts, and the overall call. Lead with what is new — a reader scanning it should see regressions before the known-defect recap.

End every GitHub comment with the attribution footer:

```
---
_Generated by [Claude Code](https://claude.ai/code)_
```

Do not open PRs or push fixes from this routine. It reports; a human decides what to fix.
