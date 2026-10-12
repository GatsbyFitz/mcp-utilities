import { sql } from "@/lib/db";
import type { ReferenceSource } from "@/lib/references";

// ---------------------------------------------------------------------------
// Reading and writing reference_sources
// ---------------------------------------------------------------------------
// Split from lib/references.ts so the vocabulary — the kind, the id namespace,
// the descriptor rule — can be imported without `lib/db` constructing a client
// at module load. The same split as lib/compliance.ts vs lib/complianceStore.ts
// and lib/aerPerformance.ts vs lib/aerPerformanceStore.ts.

interface Row {
  name: string;
  url: string;
  title: string;
  summary: string;
  key_terms: string[] | null;
  indexed_at: string | Date | null;
}

function toSource(row: Row): ReferenceSource {
  return {
    name: row.name,
    url: row.url,
    title: row.title,
    summary: row.summary,
    keyTerms: row.key_terms ?? [],
    indexedAt: row.indexed_at ? new Date(row.indexed_at).toISOString() : null,
  };
}

/** Every reference, newest descriptor first. Small by construction. */
export async function listReferences(): Promise<ReferenceSource[]> {
  const rows = (await sql`
    SELECT name, url, title, summary, key_terms, indexed_at
    FROM reference_sources
    ORDER BY title
  `) as Row[];
  return rows.map(toSource);
}

/** The rows behind a set of vector ids, in the order the ids were given. */
export async function referencesByName(names: string[]): Promise<ReferenceSource[]> {
  if (names.length === 0) return [];
  const rows = (await sql`
    SELECT name, url, title, summary, key_terms, indexed_at
    FROM reference_sources
    WHERE name = ANY(${names}::text[])
  `) as Row[];

  const byName = new Map(rows.map((r) => [r.name, toSource(r)]));
  return names.map((n) => byName.get(n)).filter((r): r is ReferenceSource => r !== undefined);
}

/**
 * Upserts one reference.
 *
 * Keyed on `name`, so resubmitting a page corrects it in place rather than
 * adding a second entry that would split the matches between them.
 * `indexed_at` is set by the caller *after* the vector write succeeds — a row
 * whose embedding failed must read as unindexed rather than as searchable.
 */
export async function upsertReference(source: {
  name: string;
  url: string;
  title: string;
  summary: string;
  keyTerms: string[];
}): Promise<void> {
  await sql`
    INSERT INTO reference_sources (name, url, title, summary, key_terms, updated_at)
    VALUES (
      ${source.name}, ${source.url}, ${source.title}, ${source.summary},
      ${source.keyTerms}::text[], NOW()
    )
    ON CONFLICT (name) DO UPDATE SET
      url        = EXCLUDED.url,
      title      = EXCLUDED.title,
      summary    = EXCLUDED.summary,
      key_terms  = EXCLUDED.key_terms,
      updated_at = NOW(),
      -- Cleared deliberately: the descriptor has changed, so whatever is in
      -- the index describes the old one until the new embedding lands.
      indexed_at = NULL
  `;
}

/** Marks the descriptor as embedded. Called only after the vector upsert. */
export async function markReferenceIndexed(name: string): Promise<void> {
  await sql`UPDATE reference_sources SET indexed_at = NOW() WHERE name = ${name}`;
}

/** Removes a reference. The caller deletes its vector; this is only the row. */
export async function deleteReference(name: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM reference_sources WHERE name = ${name} RETURNING name
  `) as { name: string }[];
  return rows.length > 0;
}
