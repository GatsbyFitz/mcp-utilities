import { generateText, embedMany, Output } from "ai";
import * as z from "zod/v4";
import { mapPool } from "@/lib/pool";
import { vectorIndex, escapeFilterValue } from "@/lib/vector";
import { sparseVector } from "@/lib/sparse";
import { extractTitle } from "@/lib/chunking";
import { documentCitationMeta } from "@/lib/documentMeta";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import { checkMermaid, nodeLabels } from "@/lib/mermaidCheck";
import {
  PROCESS_KIND,
  processId,
  MAX_MERMAID_CHARS,
  MAX_PROCESS_ACTORS,
  MAX_PROCESS_TITLE,
  MAX_PROCESSES_PER_DOCUMENT,
} from "@/lib/processes";
import { figureId, figureIdPrefix } from "@/lib/figures";
import type { BlobInfo } from "./recordUpload";

// ---------------------------------------------------------------------------
// Step: read the process out of a figure, as Mermaid
// ---------------------------------------------------------------------------
// `extractFigures` gives us the pixels and a sentence describing them. Neither
// answers "what happens if this step is rejected?" — that is in the arrows, and
// a model handed a PNG cannot follow them.
//
// So each figure is shown to the model and, when it depicts a process, comes
// back as Mermaid. The model writes the diagram: it is a notation models write
// fluently, and the same string then serves both readers — `display_process`
// returns the source for the model to read, and the viewer renders it.
//
// The risk that buys is that invalid Mermaid fails *silently*, as an empty
// frame in the host's iframe. Three things hold that down, none of which take
// authorship away from the model: the rules are stated in the prompt, the
// result is validated before it is stored, and a failure gets one repair round
// with the specific complaint in hand. A diagram that survives none of that is
// still stored, flagged invalid, and rendered as the figure image instead —
// dropping it would lose the only machine-readable copy of the process.

/** A figure to look at. Same shape whether it came from this run or the index. */
export interface ProcessSource {
  /** The figure's vector id, so a process can be traced back to its image. */
  figureId: string;
  page: number | null;
  imageUrl: string;
  description: string;
}

export interface ExtractedProcess {
  figureId: string;
  page: number | null;
  imageUrl: string;
  title: string;
  actors: string[];
  mermaid: string;
  mermaidValid: boolean;
}

/**
 * The figures a document already has, read back from the index.
 *
 * This is what makes a re-scan cheap: the figures carry their image URL, their
 * page and their description, so nothing here touches the PDF, renders a page
 * or re-runs the Markdown parse. It is also why a document ingested before this
 * feature existed can be scanned without re-ingesting it.
 */
export async function readFigureSources(fileName: string): Promise<ProcessSource[]> {
  "use step";

  const result: { vectors: { id: string | number; metadata?: Record<string, unknown> }[] } =
    await vectorIndex.range({
      prefix: figureIdPrefix(fileName),
      cursor: "",
      limit: MAX_PROCESSES_PER_DOCUMENT,
      includeVectors: false,
      includeMetadata: true,
    });

  return result.vectors
    .flatMap((vector) => {
      const metadata = vector.metadata ?? {};
      const imageUrl = typeof metadata.imageUrl === "string" ? metadata.imageUrl : null;
      // No image, nothing to read the process out of.
      if (!imageUrl) return [];
      const page = typeof metadata.pageStart === "number" ? metadata.pageStart : null;
      return [
        {
          figureId: String(vector.id),
          page,
          imageUrl,
          description: typeof metadata.text === "string" ? metadata.text : "",
        },
      ];
    })
    // Page order, so the numbering a reader sees follows the document.
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.figureId.localeCompare(b.figureId));
}

/**
 * The figures this run just produced, as sources.
 *
 * Index alignment with `figureId` is not incidental: `embedFigures` indexes the
 * same array in the same order, so figure `n` here is the vector `figureId`
 * gives it there. Keep the two in step.
 */
export function sourcesFromFigures(
  fileName: string,
  figures: { page: number; description: string; imageUrl: string }[]
): ProcessSource[] {
  return figures.map((figure, i) => ({
    figureId: figureId(fileName, i),
    page: figure.page,
    imageUrl: figure.imageUrl,
    description: figure.description,
  }));
}

/** Figures examined at once. Matches the concurrency extractFigures uses. */
const CONCURRENCY = 3;

/** A crop larger than this is not worth the request. */
const MAX_IMAGE_BYTES = 6_000_000;

const PROMPT = `You are reading one figure from a regulatory document.

Decide first whether it depicts a PROCESS — a flow of steps, a lifecycle, a state machine, a sequence of actions between parties, a decision tree. A bar chart, a photograph, a map, a screenshot, an org chart or a bare schematic is NOT a process: return isProcess false and nothing else.

If it is a process, transcribe it as Mermaid, following these rules exactly:

- Start with "flowchart TD" (or "flowchart LR" if the diagram clearly reads left to right).
- Node ids MUST be synthetic: n0, n1, n2, ... NEVER use a word from the diagram as an id. "end" in particular is a reserved Mermaid keyword and will break the diagram.
- Every node's visible text goes in its label, in double quotes: n3["Review Exemption"].
- Write a literal double quote inside a label as &quot;. Never leave a quote unclosed.
- Put the text on an arrow between pipes, in quotes: n3 -->|"REJECT"| n7.
- Terminals use the stadium shape: n0(["Start"]). Decisions use n4{"Approved?"}.
- If the diagram separates responsibilities into lanes or colour-codes actors, group the nodes with subgraph blocks named for the actor.
- Transcribe every box and every arrow, including loop-backs that route around the outside of the diagram. A missing arrow changes what the process means.
- Use only the labels written on the diagram. Do not invent steps, and do not tidy the wording.

Also return:
- "title": what the diagram is called, or a short description of it if it is untitled.
- "actors": the parties the diagram assigns actions to, exactly as named on it. Empty if it does not distinguish any.`;

const ProcessSchema = z.object({
  isProcess: z.boolean(),
  title: z.string().default(""),
  actors: z.array(z.string()).default([]),
  mermaid: z.string().default(""),
});

export async function extractProcesses(
  fileName: string,
  blob: BlobInfo,
  /** Null on a re-scan, which has no reason to fetch the Markdown just for a title. */
  markdown: string | null,
  sources: ProcessSource[]
): Promise<{ processCount: number; repaired: number; invalid: number }> {
  "use step";

  // Always clear first, even with nothing to add: a re-scan that finds fewer
  // processes than last time must not leave the surplus behind, and upsert
  // alone would. Scoped by `kind`, so chunks and figures are untouched.
  await vectorIndex.delete({
    filter: `source = '${escapeFilterValue(fileName)}' AND kind = '${PROCESS_KIND}'`,
  });

  if (sources.length === 0) return { processCount: 0, repaired: 0, invalid: 0 };

  let repaired = 0;

  // mapPool awaits every runner together, so one unhandled throw would discard
  // a document that has already paid for parsing, embedding, the graph and its
  // figures. A figure that cannot be read is simply not a process.
  const results = await mapPool(sources.slice(0, MAX_PROCESSES_PER_DOCUMENT), CONCURRENCY, async (source, n) => {
    try {
      const outcome = await processFor(fileName, source, n);
      if (outcome?.wasRepaired) repaired++;
      return outcome?.process ?? null;
    } catch (error) {
      console.warn(`[extractProcesses] ${fileName} figure ${n}: skipped —`, error);
      return null;
    }
  });

  const processes = results.filter((p): p is ExtractedProcess => p !== null);
  if (processes.length === 0) return { processCount: 0, repaired, invalid: 0 };

  const title = markdown ? extractTitle(markdown, fileName) : fileName;
  const { version, publisher } = documentCitationMeta(fileName);

  // Embedded from the words on the diagram, not from the Mermaid source: the
  // ids are synthetic and the syntax is noise, while the box and arrow labels
  // are exactly the words a question about the process uses.
  const texts = processes.map((p) => embeddableText(p));

  const { embeddings } = await embedMany({
    model: EMBEDDING_MODEL,
    values: texts.map((text) => `title: ${title} | text: ${text}`),
    providerOptions: {
      google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: "RETRIEVAL_DOCUMENT" },
    },
  });

  await vectorIndex.upsert(
    processes.map((process, i) => ({
      id: processId(fileName, i),
      vector: embeddings[i],
      // The index is hybrid: a dense-only upsert is rejected outright and
      // nothing is written. Unprefixed text, as every other writer uses.
      sparseVector: sparseVector(texts[i]),
      metadata: {
        // Mirrors a chunk's shape so toCitation needs no special case.
        text: process.title,
        title,
        source: fileName,
        blobUrl: blob.url,
        blobDownloadUrl: blob.downloadUrl,
        blobPath: blob.pathname,
        pageStart: process.page,
        pageEnd: process.page,
        version,
        publisher,
        // The fields that make it a process.
        kind: PROCESS_KIND,
        mermaid: process.mermaid,
        mermaidValid: process.mermaidValid,
        actors: process.actors,
        imageUrl: process.imageUrl,
        figureId: process.figureId,
      },
    }))
  );

  const invalid = processes.filter((p) => !p.mermaidValid).length;
  console.log(
    `[extractProcesses] ${fileName}: ${processes.length} process(es) from ${sources.length} figure(s)` +
      `, ${repaired} repaired, ${invalid} still invalid`
  );

  return { processCount: processes.length, repaired, invalid };
}

/** What gets embedded: the title, the actors, and the text on the diagram. */
function embeddableText(process: ExtractedProcess): string {
  return [process.title, process.actors.join(", "), nodeLabels(process.mermaid).join(" | ")]
    .filter(Boolean)
    .join(" | ");
}

/** One figure: look at it, and transcribe it if it is a process. */
async function processFor(
  fileName: string,
  source: ProcessSource,
  n: number
): Promise<{ process: ExtractedProcess; wasRepaired: boolean } | null> {
  const image = await fetchCrop(source.imageUrl);
  if (!image) return null;

  const first = await askForMermaid(image, PROMPT);
  if (!first.isProcess || !first.mermaid.trim()) return null;

  let mermaid = first.mermaid.trim();
  let problems = checkMermaid(mermaid);
  let wasRepaired = false;

  // One repair round, with the complaint in hand. Still the model authoring the
  // diagram — it is being shown its own output and told what is wrong with it.
  if (problems.length > 0) {
    console.warn(
      `[extractProcesses] ${fileName} figure ${n}: invalid Mermaid, repairing — ${problems.join("; ")}`
    );
    const repair = await askForMermaid(
      image,
      `${PROMPT}\n\nYour previous attempt was rejected. Fix these problems and return the corrected diagram:\n${problems
        .map((p) => `- ${p}`)
        .join("\n")}\n\nPrevious attempt:\n${mermaid}`
    );
    if (repair.mermaid.trim()) {
      const repairedProblems = checkMermaid(repair.mermaid.trim());
      // Keep the repair only if it is actually better; a "fix" that introduces
      // new faults is worse than the original.
      if (repairedProblems.length < problems.length) {
        mermaid = repair.mermaid.trim();
        problems = repairedProblems;
        wasRepaired = true;
      }
    }
  }

  if (problems.length > 0) {
    console.warn(
      `[extractProcesses] ${fileName} figure ${n}: still invalid after repair — ${problems.join("; ")}`
    );
  }

  return {
    wasRepaired,
    process: {
      figureId: source.figureId,
      page: source.page,
      imageUrl: source.imageUrl,
      title: (first.title || source.description).slice(0, MAX_PROCESS_TITLE),
      actors: first.actors.map((a) => a.trim()).filter(Boolean).slice(0, MAX_PROCESS_ACTORS),
      mermaid: mermaid.slice(0, MAX_MERMAID_CHARS),
      mermaidValid: problems.length === 0,
    },
  };
}

async function askForMermaid(
  image: { bytes: Buffer; mimeType: string },
  prompt: string
): Promise<{ isProcess: boolean; title: string; actors: string[]; mermaid: string }> {
  const { output } = await generateText({
    model: "google/gemini-3.5-flash-lite",
    output: Output.object({ schema: ProcessSchema }),
    messages: [
      {
        role: "user",
        content: [
          { type: "image", image: image.bytes, mediaType: image.mimeType },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  return {
    isProcess: output.isProcess ?? false,
    title: (output.title ?? "").trim(),
    actors: output.actors ?? [],
    mermaid: stripFence(output.mermaid ?? ""),
  };
}

/**
 * The stored crop, which is the one worth reading.
 *
 * Deliberately not the copy `embedFigures` sends: that render is capped at
 * 768px to fit an embedding request's token budget, and a dense flowchart is
 * illegible at that size — transcribing it would invent labels.
 */
async function fetchCrop(url: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[extractProcesses] crop fetch failed: ${res.status} ${url}`);
    return null;
  }
  const mimeType = res.headers.get("content-type") ?? "image/png";
  if (!mimeType.startsWith("image/")) return null;

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    console.warn(`[extractProcesses] crop too large (${bytes.byteLength} bytes): ${url}`);
    return null;
  }
  return { bytes, mimeType };
}

/** Models fence code even when asked for a bare string. */
function stripFence(text: string): string {
  const fenced = text.trim().match(/^```(?:mermaid)?\s*\n([\s\S]*?)\n?```$/);
  return (fenced ? fenced[1] : text).trim();
}
