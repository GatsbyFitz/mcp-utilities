// ---------------------------------------------------------------------------
// Processes extracted from figures, as Mermaid
// ---------------------------------------------------------------------------
// A figure that depicts a process carries information the description around it
// cannot. "What happens if Review Exemption is rejected?" is answerable from the
// arrows and from nothing else, and a model handed a PNG URL cannot read them.
//
// So a process is transcribed into Mermaid and indexed. Mermaid is the notation
// precisely because it serves both readers at once: `display_process` returns
// the source, which a model reads natively, and the viewer renders the same
// string as a diagram. One artifact, no second representation to drift.
//
// Stored in Upstash rather than in a table of its own, for the reason
// lib/figureCounts.ts already gives about counts: a record kept beside the index
// is a claim about the index that nothing keeps true. Processes need top-k
// search ("which process covers this?") and per-document listing — the index
// does both natively, by `kind` filter and by id prefix. Compliance actions
// needed Postgres because they needed *aggregates over every row*; a process
// never does.

/** Marks a vector entry as a process rather than a chunk or a figure. */
export const PROCESS_KIND = "process";

/**
 * `#` rather than `-process-`, for the reason `figureId` gives: `chunkId`
 * produces `${fileName}-${index}`, so a document literally named
 * `report-process` would otherwise collide with the processes of `report`.
 */
export function processId(fileName: string, index: number): string {
  return `${fileName}#process-${index}`;
}

/** Id prefix covering every process of one document, for a `range` scan. */
export function processIdPrefix(fileName: string): string {
  return `${fileName}#process-`;
}

/**
 * The document a process vector belongs to, or null if the id is not a process.
 * Splits on the *last* separator so a file name containing "#process-" cannot
 * truncate the name it returns.
 */
export function documentOfProcessId(id: string): string | null {
  const at = id.lastIndexOf("#process-");
  if (at <= 0) return null;
  const index = id.slice(at + "#process-".length);
  return /^\d+$/.test(index) ? id.slice(0, at) : null;
}

// ---------------------------------------------------------------------------
// Limits, applied in code
// ---------------------------------------------------------------------------
// Gemini drops most string and array JSON Schema constraints, so `.min`/`.max`
// on the schema would fail to steer the model while still rejecting otherwise
// usable responses. See the workflow-steps rule.

/** A diagram longer than this is a transcription that has run away. */
export const MAX_MERMAID_CHARS = 8000;
export const MAX_PROCESS_TITLE = 200;
export const MAX_PROCESS_ACTORS = 24;
/** Processes per document. A figure yields at most one. */
export const MAX_PROCESSES_PER_DOCUMENT = 60;

/** One stored process, as read back for display or for a tool result. */
export interface DocumentProcess {
  /** The vector id, `${fileName}#process-${n}`. */
  id: string;
  title: string;
  /** Mermaid source. The process itself, not a rendering of it. */
  mermaid: string;
  /**
   * False when the diagram failed validation and could not be repaired. It is
   * still stored and still returned — a flawed transcription beats silently
   * dropping the only machine-readable copy of the process — but the viewer
   * shows the figure image instead of an empty frame.
   */
  mermaidValid: boolean;
  actors: string[];
  page: number | null;
  /** The figure this was read from, so the reader can check the transcription. */
  imageUrl: string | null;
  sourceUrl: string | null;
  document: string;
}
