// ---------------------------------------------------------------------------
// Shared chunking
// ---------------------------------------------------------------------------
// The embedding step and the graph-extraction step must agree byte-for-byte on
// chunk boundaries and IDs: search_graph stores a chunkId on every relationship
// and later feeds it straight to vectorIndex.fetch(). If the two steps chunked
// independently and drifted, every graph hit would fetch a missing or wrong
// excerpt. One implementation, imported by both.

/** Canonical vector-index ID for a chunk. */
export function chunkId(fileName: string, index: number): string {
  return `${fileName}-${index}`;
}

export function chunkText(text: string, size = 500): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(" "));
  }
  return chunks;
}

export function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.(pdf|docx?|txt|md)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function extractTitle(markdown: string, filename: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : titleFromFilename(filename);
}
