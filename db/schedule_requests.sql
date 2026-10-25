-- Workbooks the `submit_schedule` MCP tool was asked to ingest without the
-- credential that authorises ingesting one. Nothing here has been fetched: a
-- row becomes observations in `aer_performance` only when a signed-in human
-- approves it, at which point the server fetches the URL and starts the same
-- `ingestSchedule` workflow a browser upload starts.
--
-- Separate from `document_requests` rather than a `kind` column on it, for the
-- reason file-uploads.md gives about the ingest routes: the two authorise and
-- resolve different things. A document request needs a title and resolves into
-- `ingestPdf`; a schedule request needs a schedule number and a period label —
-- which are the whole identity of a workbook and are typed by a person because
-- they are on the release page and not reliably inside the file — and resolves
-- into `ingestSchedule`. Widening the PDF queue would mean branching its
-- approval route on a column and losing the typed period.
--
-- Like every other table here, this is not created by application code. Run it
-- once against the provisioned Neon database. See
-- .claude/conventions/data-stores.md.

CREATE TABLE IF NOT EXISTS schedule_requests (
  id            TEXT PRIMARY KEY,
  -- 2, 3 or 4. Not a FK — SCHEDULES lives in lib/aerPerformance.ts and the
  -- check keeps a typo out without duplicating the vocabulary in two places.
  schedule      INTEGER     NOT NULL CHECK (schedule IN (2, 3, 4)),
  -- "2023-24 Q3", normalised by `normalizePeriodLabel` before it gets here.
  -- A quarter filed under the wrong label is wrong in a way no later query
  -- could detect, which is why this is stored verbatim as supplied and
  -- re-validated on approval rather than inferred from the workbook.
  period_label  TEXT        NOT NULL,
  -- Where the submitter says the workbook is. Advisory only until approved:
  -- it is shown to the approver, never fetched on an unauthenticated caller's
  -- say-so. See lib/ingestSecret.ts.
  source_url    TEXT        NOT NULL,
  -- Why it was submitted, and who by, as free text from the MCP client.
  -- Untrusted; rendered as text, never as markup.
  note          TEXT,
  requested_by  TEXT,
  -- pending → approved (fetched, workflow started) | rejected | failed
  status        TEXT        NOT NULL DEFAULT 'pending',
  status_detail TEXT,
  -- The ingestion run started on approval, so the upload page can track it
  -- with the same per-step progress it shows a browser upload.
  run_id        TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS schedule_requests_status_idx
  ON schedule_requests (status, requested_at DESC);

-- One open request per (schedule, quarter). A second client asking for the
-- same workbook should join the existing request rather than add a duplicate
-- for someone to work through twice. Not unique on the URL: the AER has
-- republished a corrected workbook at a new path for the same quarter, and
-- that is the same request.
CREATE UNIQUE INDEX IF NOT EXISTS schedule_requests_pending_idx
  ON schedule_requests (schedule, period_label)
  WHERE status = 'pending';
