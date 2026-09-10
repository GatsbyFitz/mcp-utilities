-- Ingestions that have started but not finished.
--
-- `uploads` records a document only once `recordUpload` runs, which is the very
-- last step. Until then the only handle on a run is its run id, and that lives
-- in the browser tab that started it — a refresh strands the run permanently,
-- including the Gemini-parsed Markdown it already paid for. This table is the
-- durable handle: a row exists from the moment a run starts and is deleted by
-- `recordUpload`, so the table's contents *are* the ingestions needing
-- finalisation.
--
-- Keyed by normalised file name rather than run id, because a document is
-- identified by its name everywhere else (chunk ids, vector metadata,
-- `sourceDoc` on graph edges) and because a retry starts a *new* run for the
-- same document. The primary key therefore also closes a gap the `uploads`
-- duplicate check cannot: two concurrent uploads of the same name, neither of
-- which is in `uploads` yet.
--
-- Like `uploads` and `document_requests`, this table is not created by
-- application code. Run it once against the provisioned Neon database.
-- See .claude/conventions/data-stores.md.

CREATE TABLE IF NOT EXISTS ingestion_runs (
  -- LOWER(TRIM(file name)) — the same comparison `uploads` is checked with.
  name              TEXT PRIMARY KEY,
  -- The name as uploaded, which is what the workflow and every id actually use.
  display_name      TEXT        NOT NULL,
  size_bytes        BIGINT      NOT NULL,
  -- The PDF, already in Blob before the run started.
  blob_url          TEXT        NOT NULL,
  blob_download_url TEXT        NOT NULL,
  blob_path         TEXT        NOT NULL,
  -- Set by `markResumePoint`, once the expensive PDF→Markdown parse is banked.
  -- Its presence is what makes a row finishable without re-parsing the PDF.
  markdown_url      TEXT,
  -- Newest workflow run for this document. Replaced on every retry, so it is a
  -- pointer for progress polling, not an identity.
  run_id            TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The list the upload page asks for: resumable rows first, newest first.
CREATE INDEX IF NOT EXISTS ingestion_runs_updated_idx
  ON ingestion_runs (updated_at DESC);
