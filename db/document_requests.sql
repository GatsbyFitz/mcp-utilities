-- Requests from the MCP server's `request_document` tool: documents a model
-- looked for and could not find. Nothing here is in the RAG store yet — a row
-- becomes a document only when a signed-in human approves it and supplies a
-- URL to fetch.
--
-- Like `uploads`, this table is not created by application code. Run it once
-- against the provisioned Neon database. See .claude/conventions/data-stores.md.

CREATE TABLE IF NOT EXISTS document_requests (
  id            TEXT PRIMARY KEY,
  -- What the model asked for, and why it thinks the corpus needs it.
  title         TEXT        NOT NULL,
  reason        TEXT,
  -- Where the model believes the document lives. Advisory only: it is shown
  -- to the approver, never fetched on the model's say-so.
  source_url    TEXT,
  -- Free-text hint about who asked, from the MCP client. Untrusted.
  requested_by  TEXT,
  -- pending → approved (fetched, workflow started) | rejected | failed
  status        TEXT        NOT NULL DEFAULT 'pending',
  status_detail TEXT,
  -- Ingestion run started on approval, so the upload page can track it with
  -- the same per-step progress it shows for a browser upload.
  run_id        TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS document_requests_status_idx
  ON document_requests (status, requested_at DESC);

-- One open request per title. A second model asking for the same thing should
-- join the existing request rather than add a duplicate to the review queue.
CREATE UNIQUE INDEX IF NOT EXISTS document_requests_pending_title_idx
  ON document_requests (LOWER(TRIM(title)))
  WHERE status = 'pending';
