import { z } from "zod";
import { embed } from "ai";
import type { McpServer } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps";
import { baseURL } from "@/baseUrl";
import { vectorIndex, escapeFilterValue } from "@/lib/vector";
import { FIGURE_KIND } from "@/lib/figures";
import { PROCESS_KIND } from "@/lib/processes";
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
const resourceUri = "ui://display-process/mcp-app-v2.html";

/** Figures per call. Enough to compare a few, few enough to stay navigable. */
const MAX_PROCESSES = 12;

/**
 * Where the figure PNGs live. Vercel Blob serves them from a per-store
 * subdomain, which the iframe must be allowed to load images from — without
 * this the viewer renders empty frames and nothing says why.
 */
const BLOB_IMAGE_ORIGIN = "https://*.public.blob.vercel-storage.com";

/**
 * A process read out of a figure, as Mermaid.
 *
 * The Mermaid is the point. A host renders it as a diagram, and — far more
 * importantly — the model reads the source directly in the text block below, so
 * "what happens if this is rejected?" is answerable from the arrows instead of
 * from a sentence about a picture.
 */
interface ProcessDiagram {
  id: string;
  title: string;
  document: string;
  page: number | null;
  mermaid: string;
  /** False when the diagram failed validation; the viewer shows the crop. */
  mermaidValid: boolean;
  actors: string[];
  imageUrl: string | null;
  sourceUrl: string | null;
  score: number;
}

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
        "Show a process from the indexed documents as a Mermaid flowchart you " +
        "can read, plus the original diagram. Use this when the answer to a " +
        "question IS a process — a flow, a lifecycle, a sequence of " +
        "obligations between parties, what happens when something is rejected " +
        "or approved — rather than prose that mentions one. The returned " +
        "Mermaid is the transcribed diagram, so you can follow its arrows and " +
        "answer questions about branches and loops directly from it; quote the " +
        "step and condition labels as written. Search is semantic over the " +
        "text on the diagram, so describe the process in words ('meter churn " +
        "between retailer and metering coordinator'), not by figure number. " +
        "Restrict to one document with `document` when the question names one. " +
        "Documents that have not been scanned for processes fall back to the " +
        "figure image. For prose, or a mix of prose and figures, use " +
        "search_docs instead.",
      inputSchema: z.object({
        query: z.string().min(2).max(1000),
        document: z.string().max(300).optional(),
      }),
      _meta: { ui: { resourceUri } },
    },
    async ({ query, document }) => {
      try {
        const diagrams = await findProcessDiagrams(query, document);
        // Only when nothing has been transcribed: a document scanned for
        // processes should not have its answer diluted by raw figures, but one
        // that never has must still return what it has.
        const figures = diagrams.length > 0 ? [] : await findProcesses(query, document);

        if (diagrams.length === 0 && figures.length === 0) {
          const scope = document ? ` in ${document}` : "";
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No process or figure matches "${query}"${scope}. Processes ` +
                  `exist only for documents that have had figure extraction and ` +
                  `then a process scan run, so the process may be described in ` +
                  `prose — try search_docs.`,
              },
            ],
            structuredContent: { query, document: document ?? null, processes: [], figures: [] },
          };
        }

        // The citation scaffolding search_docs uses, so a host without UI
        // support gets exactly what it would have got from a normal search.
        const citations = [...diagrams.map((d) => d.citation), ...figures.map((f) => f.citation)];

        const renderedProcesses = diagrams.map((d, i) => {
          const actors = d.process.actors.length > 0 ? `\nActors: ${d.process.actors.join(", ")}` : "";
          // Fenced so the diagram survives as a block rather than being read as
          // prose, and so a host that renders Markdown draws it.
          const diagram = `\n\n\u0060\u0060\u0060mermaid\n${d.process.mermaid}\n\u0060\u0060\u0060`;
          const caveat = d.process.mermaidValid
            ? ""
            : "\n(This transcription did not validate — treat it as indicative and check the figure.)";
          return `${citationLine(i + 1, d.citation, d.process.score)}${actors}${diagram}${caveat}\n${figureLine(d.citation)}`;
        });

        const renderedFigures = figures.map((f, i) => {
          const n = diagrams.length + i + 1;
          return `${citationLine(n, f.citation, f.figure.score)}\n${figureLine(f.citation)}\n${f.figure.description}`;
        });

        const rendered = [...renderedProcesses, ...renderedFigures].join("\n\n---\n\n");
        const found = diagrams.length > 0
          ? `${diagrams.length} process(es)`
          : `${figures.length} figure(s)`;

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Found ${found} for "${query}".\n\n` +
                `${rendered}\n\nSources:\n${sourceList(citations)}`,
            },
          ],
          structuredContent: {
            query,
            document: document ?? null,
            processes: diagrams.map((d) => d.process),
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
 * Semantic search restricted to transcribed processes.
 *
 * Same index, same vector space, same query embedding as `search_docs` — the
 * only thing separating a process from a chunk or a figure is its `kind`, which
 * is what made it additive. The query is embedded exactly as search_docs embeds
 * one, since both sides of the asymmetric convention have to agree.
 */
async function findProcessDiagrams(
  query: string,
  document?: string
): Promise<{ process: ProcessDiagram; citation: ReturnType<typeof toCitation> }[]> {
  const { embedding } = await embed({
    model: EMBEDDING_MODEL,
    value: `task: search result | query: ${query}`,
    providerOptions: {
      google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: "RETRIEVAL_QUERY" },
    },
  });

  const filter = [
    `kind = '${PROCESS_KIND}'`,
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
    const metadata = (match.metadata ?? {}) as ChunkMetadata & {
      mermaid?: string;
      mermaidValid?: boolean;
      actors?: string[];
    };
    // A process with no diagram is nothing at all — the Mermaid *is* the
    // process, not a rendering of something stored elsewhere.
    if (!metadata.mermaid) return [];

    const citation = toCitation(metadata);
    return [
      {
        citation,
        process: {
          id: String(match.id),
          title: citationLabel(citation),
          document: citation.source,
          page: citation.pageStart,
          mermaid: metadata.mermaid,
          // Absent on nothing current, but an older entry predating the flag
          // should read as valid rather than be shown with a warning.
          mermaidValid: metadata.mermaidValid !== false,
          actors: Array.isArray(metadata.actors) ? metadata.actors : [],
          imageUrl: metadata.imageUrl ?? null,
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
