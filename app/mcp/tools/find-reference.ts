import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { embed, rerank } from "ai";
import { WeightingStrategy } from "@upstash/vector";
import { vectorIndex } from "@/lib/vector";
import { sparseVector } from "@/lib/sparse";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import { RERANK_MODEL } from "@/lib/models";
import {
  MAX_REFERENCE_RESULTS,
  MIN_REFERENCE_RELEVANCE,
  MISSING_REFERENCES_MESSAGE,
  REFERENCE_CANDIDATES,
  REFERENCE_KIND,
  descriptorText,
  relevantReferences,
  isMissingReferenceTable,
  type ReferenceMatch,
} from "@/lib/references";
import { listReferences } from "@/lib/referenceStore";

// ---------------------------------------------------------------------------
// find_reference — a router, not a retriever
// ---------------------------------------------------------------------------
// Every other search tool here answers a question. This one answers "where
// should I look", and hands back a URL for the caller to open itself.
//
// That split exists because these pages fail differently from the corpus. API
// documentation versions, and a moved endpoint reads exactly like a working
// one — so an indexed copy of the text is a confident lie. What is indexed is
// a *descriptor* of what each page covers, which ages far more slowly, and the
// page is read live by whoever asked.
//
// It also puts the fetching where the freshest copy is. The server knows what
// exists and which of it is relevant; the client knows how to read a page and
// is reading it now. Neither can do the other's half. (An earlier comment here
// said this server could not reach these pages at all. That was checked and is
// wrong — see .claude/conventions/data-stores.md — but it changes nothing: the
// point is that an indexed copy goes stale and a live read cannot.)

function renderMatch(match: ReferenceMatch, n: number): string {
  const terms = match.keyTerms.length ? `\nCovers: ${match.keyTerms.join(", ")}` : "";
  // The relevance is printed, not just returned. Per the mcp-tools rule the
  // text block is what a model reads and acts on, and this tool's instruction
  // is "go and open this" — so a weak match has to be able to announce itself
  // as weak, rather than looking identical to a strong one.
  return `[${n}] ${match.title} (relevance ${match.score.toFixed(3)})\n${match.url}\n${match.summary}${terms}`;
}

export function registerFindReferenceTool(server: McpServer): void {
  server.registerTool(
    "find_reference",
    {
      title: "find_reference",
      description:
        "Find which live reference page answers a question, and get its URL. " +
        "These are sources kept current rather than indexed — API " +
        "documentation and specifications, where being out of date is the " +
        "worst failure, because a moved endpoint looks exactly like a working " +
        "one. " +
        // The mechanism, stated rather than implied. A description that only
        // says "returns relevant URLs" gets treated as a reading list, and the
        // model answers from the summary — which describes what the page is
        // about, not what it says.
        "IMPORTANT: this returns pointers, not content. The summaries " +
        "describe what each page *covers*; they do not contain the answer. " +
        "You must fetch the returned URL yourself — with your own web " +
        "browsing or fetch capability — and answer from the live page. Do not " +
        "answer from the summary, and do not claim a page lacks something you " +
        "have not opened. If you cannot fetch URLs, say so and give the user " +
        "the link rather than guessing at its contents. " +
        "Use this for how to *call* an API, for current endpoints, schemas " +
        "and specifications. For what the market rules require, and for " +
        "anything needing a citation, use search_docs — these pages are not " +
        "in the document index and have no page citations.",
      inputSchema: z.object({
        question: z.string().min(2).max(1000),
      }),
    },
    async ({ question }) => {
      try {
        const { embedding } = await embed({
          model: EMBEDDING_MODEL,
          value: `task: search result | query: ${question}`,
          providerOptions: {
            google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: "RETRIEVAL_QUERY" },
          },
        });

        const matches = await vectorIndex.query({
          vector: embedding,
          // Same tokenisation as the document side, or term overlap silently
          // stops matching. Key terms like "MSATS" live or die on this half.
          sparseVector: sparseVector(question),
          weightingStrategy: WeightingStrategy.IDF,
          topK: REFERENCE_CANDIDATES,
          filter: `kind = '${REFERENCE_KIND}'`,
          includeMetadata: true,
          includeVectors: false,
        });

        // Read back from Postgres rather than trusting the vector metadata:
        // the row is the source of truth for the URL, and a descriptor edited
        // after indexing would otherwise be served from a stale copy.
        const names = (Array.isArray(matches) ? matches : []).map((m) =>
          String((m.metadata as { source?: unknown })?.source ?? "")
        );
        const retrievalScores = new Map(
          (Array.isArray(matches) ? matches : []).map((m) => [
            String((m.metadata as { source?: unknown })?.source ?? ""),
            m.score,
          ])
        );

        const all = await listReferences();
        const byName = new Map(all.map((r) => [r.name, r]));
        const candidates: ReferenceMatch[] = names
          .map((n) => byName.get(n))
          .filter((r): r is NonNullable<typeof r> => r !== undefined)
          // The hybrid score, kept only so the reranked score can be compared
          // against it. It is reciprocal-rank fusion — a rank, not a relevance
          // — and is never what decides whether a page is offered.
          .map((r) => ({ ...r, score: retrievalScores.get(r.name) ?? 0 }));

        if (candidates.length === 0) {
          // "Nothing matched" and "nothing is registered" must never read
          // alike: the first is an answer, the second is a setup gap.
          const text = all.length
            ? `No reference matches "${question}". Registered references:\n` +
              all.map((r) => `- ${r.title} — ${r.url}`).join("\n")
            : "No reference pages are registered yet, so there is nothing to " +
              "point at. This is not a statement about what documentation exists.";
          return { content: [{ type: "text" as const, text }], structuredContent: { question, references: [] } };
        }

        // Rerank, exactly as search_docs does, and for a sharper reason here.
        // Retrieval decides *which* descriptors come back; only the reranker
        // produces a score that says whether any of them actually answers the
        // question. No capping as search_docs needs: a descriptor is bounded by
        // MAX_REFERENCE_SUMMARY, orders of magnitude under the rerank limit.
        // The same text that was embedded is the text that gets judged.
        const { ranking } = await rerank({
          model: RERANK_MODEL,
          query: question,
          documents: candidates.map((c) => descriptorText(c)),
          topN: Math.min(MAX_REFERENCE_RESULTS, candidates.length),
        });

        const ranked = ranking.map((r) => ({
          ...candidates[r.originalIndex],
          score: r.score,
          retrievalScore: candidates[r.originalIndex].score,
        }));
        const found = relevantReferences(ranked);

        if (found.length === 0) {
          // The third state, and the one this tool previously could not
          // express: pages are registered, retrieval returned some, and none
          // of them covers the question. Saying so beats handing over the
          // nearest row and telling the caller to go and read it.
          const best = ranked[0];
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No registered reference covers "${question}" — the closest, ` +
                  `"${best.title}", scored ${best.score.toFixed(3)} against a floor of ` +
                  `${MIN_REFERENCE_RELEVANCE}. This says nothing about whether such ` +
                  `documentation exists, only that none is registered here. ` +
                  `Registered references:\n` +
                  all.map((r) => `- ${r.title} — ${r.url}`).join("\n"),
              },
            ],
            structuredContent: {
              question,
              references: [],
              bestRejected: { name: best.name, title: best.title, score: best.score },
              floor: MIN_REFERENCE_RELEVANCE,
            },
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                `${found.length} reference page(s) to open. Fetch the URL and ` +
                `answer from the live page — the summaries below say what each ` +
                `page covers, not what it contains.\n\n` +
                found.map(renderMatch).join("\n\n---\n\n"),
            },
          ],
          structuredContent: {
            question,
            references: found.map((r) => ({
              name: r.name,
              url: r.url,
              title: r.title,
              summary: r.summary,
              keyTerms: r.keyTerms,
              score: r.score,
              // Kept distinct on purpose: `score` is the reranker's relevance
              // and is what the floor is applied to; this is the fused
              // retrieval rank it arrived with.
              retrievalScore: r.retrievalScore,
            })),
          },
        };
      } catch (error) {
        if (isMissingReferenceTable(error)) {
          return { isError: true, content: [{ type: "text" as const, text: MISSING_REFERENCES_MESSAGE }] };
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          isError: true,
          content: [{ type: "text" as const, text: `find_reference failed: ${message}` }],
        };
      }
    }
  );
}
