import { z } from "zod";
import { embed } from "ai";
import type { McpServer } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps";
import { baseURL } from "@/baseUrl";
import { vectorIndex, escapeFilterValue } from "@/lib/vector";
import { FIGURE_KIND } from "@/lib/figures";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import {
  toCitation,
  citationLabel,
  citationLine,
  figureLine,
  sourceList,
  type ChunkMetadata,
} from "@/lib/citations";

// ---------------------------------------------------------------------------
// display_process — the figures, in a viewer
// ---------------------------------------------------------------------------
// A process diagram is the one search result that a chat transcript serves
// badly. `search_docs` already returns figures, but as a downscaled image and
// a description: fine for the model, poor for a person trying to follow who
// notifies whom. The stored crop is up to 2048px and there is nowhere in a
// message to zoom it.
//
// So this pairs a tool with an HTML resource the host renders in an iframe.
// The tool is a normal tool — it returns text and structuredContent, and a
// host with no UI support still gets a usable answer. The UI is an
// enhancement, never the only path.
//
// The iframe has no session cookie, so it cannot call /api/documentFigures.
// Everything it renders arrives in `structuredContent`; the only thing it
// fetches is the figure images themselves, which is what the CSP below is for.
//
// Registration goes through `server.registerTool`/`registerResource` directly
// rather than through `registerAppTool`/`registerAppResource` from
// `@modelcontextprotocol/ext-apps/server`. Those helpers are typed against the
// older `@modelcontextprotocol/sdk` server, whose callback signature takes a
// `RequestHandlerExtra` where this repo's `@modelcontextprotocol/server` v2
// passes a `ServerContext` — structurally incompatible, and not castable
// without lying about the shape. The helpers only default the MIME type and
// tidy the callback signature, so nothing is lost by doing it by hand; the one
// thing worth importing is `RESOURCE_MIME_TYPE`, which is a plain string
// constant and the part that actually has to be right.

/** Bump on every UI change — hosts cache a resource by its URI. */
const resourceUri = "ui://display-process/mcp-app-v1.html";

/** Figures per call. Enough to compare a few, few enough to stay navigable. */
const MAX_PROCESSES = 12;

/**
 * Where the figure PNGs live. Vercel Blob serves them from a per-store
 * subdomain, which the iframe must be allowed to load images from — without
 * this the viewer renders empty frames and nothing says why.
 */
const BLOB_IMAGE_ORIGIN = "https://*.public.blob.vercel-storage.com";

interface ProcessFigure {
  id: string;
  /** "B2B Procedure v3.2" — how the document is named in a citation. */
  title: string;
  document: string;
  page: number | null;
  description: string;
  imageUrl: string;
  /** The source PDF, anchored to the page, when both are known. */
  sourceUrl: string | null;
  score: number;
}

export function registerDisplayProcessApp(server: McpServer): void {
  server.registerResource(
    "display-process-ui",
    resourceUri,
    {
      title: "Process viewer",
      description: "Interactive viewer for process diagrams extracted from documents",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await fetchViewerHtml(),
          _meta: {
            ui: {
              csp: {
                // The page is a rendered Next route, so its JS and CSS chunks
                // load from this origin — which is also why `assetPrefix` is
                // set to it. The blob origin is for the figures themselves.
                resourceDomains: [baseURL, BLOB_IMAGE_ORIGIN],
                connectDomains: [baseURL],
              },
            },
          },
        },
      ],
    })
  );

  server.registerTool(
    "display_process",
    {
      title: "Display process",
      description:
        "Show process diagrams, flowcharts and other figures extracted from " +
        "the indexed documents, in a viewer the reader can page through and " +
        "zoom. Use this when the answer to a question IS a diagram — a " +
        "process flow, a swimlane, a sequence of obligations between parties " +
        "— rather than prose that mentions one. Search is semantic over the " +
        "description embedded with each figure, so describe the process in " +
        "words ('meter churn between retailer and metering coordinator'), " +
        "not by figure number. Restrict to one document with `document` when " +
        "the question names one. For prose, or for a mix of prose and " +
        "figures, use search_docs instead.",
      inputSchema: z.object({
        query: z.string().min(2).max(1000),
        document: z.string().max(300).optional(),
      }),
      _meta: { ui: { resourceUri } },
    },
    async ({ query, document }) => {
      try {
        const figures = await findProcesses(query, document);

        if (figures.length === 0) {
          const scope = document ? ` in ${document}` : "";
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No extracted figures match "${query}"${scope}. Figures exist ` +
                  `only for documents that have had figure extraction run, so ` +
                  `the process may be described in prose — try search_docs.`,
              },
            ],
            structuredContent: { query, document: document ?? null, figures: [] },
          };
        }

        // The same rendering search_docs uses, so a host without UI support
        // gets exactly what it would have got from a normal search.
        const citations = figures.map((f) => f.citation);
        const rendered = figures
          .map((f, i) => {
            const image = figureLine(f.citation);
            return `${citationLine(i + 1, f.citation, f.figure.score)}\n${image}\n${f.figure.description}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Found ${figures.length} figure(s) for "${query}".\n\n` +
                `${rendered}\n\nSources:\n${sourceList(citations)}`,
            },
          ],
          structuredContent: {
            query,
            document: document ?? null,
            figures: figures.map((f) => f.figure),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          isError: true,
          content: [{ type: "text" as const, text: `display_process failed: ${message}` }],
        };
      }
    }
  );
}

/**
 * Semantic search restricted to figures.
 *
 * Figures sit in the same index and the same vector space as text chunks —
 * that is what made them additive — so the only thing separating them is the
 * `kind` metadata this filters on. The query is embedded exactly as
 * `search_docs` embeds one, since both are matching against the same
 * document-side vectors and the asymmetric convention only works if the two
 * sides agree.
 */
async function findProcesses(
  query: string,
  document?: string
): Promise<{ figure: ProcessFigure; citation: ReturnType<typeof toCitation> }[]> {
  const { embedding } = await embed({
    model: EMBEDDING_MODEL,
    value: `task: search result | query: ${query}`,
    providerOptions: {
      google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: "RETRIEVAL_QUERY" },
    },
  });

  const filter = [
    `kind = '${FIGURE_KIND}'`,
    ...(document ? [`source = '${escapeFilterValue(document)}'`] : []),
  ].join(" AND ");

  const matches = await vectorIndex.query({
    vector: embedding,
    filter,
    topK: MAX_PROCESSES,
    includeMetadata: true,
    includeVectors: false,
  });

  if (!Array.isArray(matches)) return [];

  return matches.flatMap((match) => {
    const metadata = (match.metadata ?? {}) as ChunkMetadata;
    // A figure with no stored image cannot be displayed, and an empty frame in
    // a viewer is worse than one fewer result.
    if (!metadata.imageUrl) return [];

    const citation = toCitation(metadata);
    return [
      {
        citation,
        figure: {
          id: String(match.id),
          title: citationLabel(citation),
          document: citation.source,
          page: citation.pageStart,
          description: metadata.text ?? "",
          imageUrl: metadata.imageUrl,
          sourceUrl:
            citation.url && citation.pageStart !== null
              ? `${citation.url}#page=${citation.pageStart}`
              : citation.url,
          score: match.score,
        },
      },
    ];
  });
}

/**
 * The viewer's HTML, fetched from the running app rather than bundled.
 *
 * This is the repo's existing MCP App shape and the reason `baseUrl.ts` is
 * also Next's `assetPrefix`: the iframe gets a rendered Next route whose asset
 * URLs are absolute, so they resolve against this origin rather than against
 * `ui://`. The alternative — a Vite single-file bundle, as the SDK examples
 * use — would mean a second build pipeline inside a Next project.
 *
 * A failure here returns a readable message rather than throwing, because a
 * broken viewer must not take down a tool call whose text answer is fine.
 */
async function fetchViewerHtml(): Promise<string> {
  const url = `${baseURL}/process`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[display-process] viewer fetch failed: ${res.status} ${url}`);
      return `<p>The process viewer could not be loaded (${res.status}).</p>`;
    }
    return await res.text();
  } catch (error) {
    console.error("[display-process] viewer fetch error:", error);
    return "<p>The process viewer could not be loaded.</p>";
  }
}
