-- Reference pages: URLs the index points at but never holds.
--
-- The corpus in `uploads` is documents this app has read and chunked. These
-- are pages it deliberately has *not* read, because their worst failure is
-- being out of date — API documentation above all, where an endpoint that
-- moved last quarter reads exactly like one that did not.
--
-- So the row holds a *descriptor* — what the page covers, which questions it
-- answers — and `find_reference` matches a question against that and hands
-- back the URL. Whoever asked then reads the page live. The descriptor ages
-- far more slowly than the page: "documents the NEM Dispatch Bidding API"
-- stays true across releases that move every endpoint in it.
--
-- Deliberately not written by scraping. The server often cannot reach these
-- pages at all (AEMO's developer portal renders client-side and is not
-- resolvable from every network), and a descriptor built from an unrendered
-- shell would describe nothing while looking indexed. The summary is supplied
-- by whoever submits the URL.
--
-- Like `uploads`, `document_requests`, `ingestion_runs`, `compliance_actions`
-- and `aer_performance`, this table is not created by application code. Run it
-- once against the provisioned Neon database.
-- See .claude/conventions/data-stores.md.

CREATE TABLE IF NOT EXISTS reference_sources (
  -- Stable key, lower-case and hyphenated. Also the vector id suffix
  -- (`reference#<name>`), so a resubmission updates in place rather than
  -- indexing the same page twice under two keys.
  name       TEXT PRIMARY KEY,
  url        TEXT        NOT NULL,
  title      TEXT        NOT NULL,
  -- What the page covers and which questions it answers. This is the text
  -- that gets embedded, so it is written for matching a question — not as a
  -- précis of the content, which would match passages that may be gone.
  summary    TEXT        NOT NULL,
  -- Literal terms a question is likely to use: API names, system names,
  -- message types. These carry the sparse half of the hybrid index, which is
  -- what matches "MSATS" or "aseXML" where dense similarity blurs them.
  key_terms  TEXT[]      NOT NULL DEFAULT '{}',
  -- When the descriptor was last embedded. Null means the row exists but the
  -- vector does not, so the reference is invisible to search — a state worth
  -- being able to see rather than infer.
  indexed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per page. Submitting the same URL under a second name would index
-- it twice and split the matches between them.
CREATE UNIQUE INDEX IF NOT EXISTS reference_sources_url_idx
  ON reference_sources (LOWER(TRIM(url)));
