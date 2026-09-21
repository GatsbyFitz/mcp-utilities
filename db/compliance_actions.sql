-- Regulatory enforcement actions, synced from the Notion "Compliance Tracker".
--
-- One row per action. Kept in Postgres rather than in a file because the sync
-- runs at request time: a serverless function cannot write into its own
-- bundle, and this is already where the app keeps structured records.
--
-- It also means `search_compliance` can answer the questions the vector index
-- cannot. "How many times has ENGIE been fined" needs *every* matching row,
-- and "total fines for family violence failures" needs arithmetic over them —
-- top-k similarity gives neither. Those are SQL's job, so the rows live here
-- and the index holds only their embeddings.
--
-- Like `uploads`, `document_requests` and `ingestion_runs`, this table is not
-- created by application code. Run it once against the provisioned Neon
-- database. See .claude/conventions/data-stores.md.

CREATE TABLE IF NOT EXISTS compliance_actions (
  -- The Notion page id, so a re-sync upserts instead of duplicating and a row
  -- deleted in Notion can be deleted here by the same key.
  page_id          TEXT PRIMARY KEY,
  summary          TEXT        NOT NULL,
  organisation     TEXT,
  -- Retail / Network / Generation / Wholesale. Worth keeping: the
  -- organisation list spans all four, so "retailer" is not a safe assumption
  -- about any given row.
  sector           TEXT,
  -- The action's own date, not the sync's. Nullable: a row may be logged
  -- before its date is known.
  action_date      DATE,
  -- Notion calls this "Regulatory Body"; kept short here because the column is
  -- read far more often than the Notion property is.
  regulator        TEXT,
  -- "Ruled", "Under Investigation", ... deliberately free text, not an enum:
  -- a status added in Notion must not break the sync.
  status           TEXT,
  -- NUMERIC, not an integer type: Notion types this as a number, so a
  -- fractional penalty is representable there and must not be silently
  -- truncated here. Null where no fine applies — an open investigation has
  -- none, which is distinct from zero, and SUM() must keep it that way.
  fine             NUMERIC,
  -- The regulator's own page for the action. What citations link to.
  source_url       TEXT,
  -- Notion multi-select. An array rather than a join table: the vocabulary is
  -- small, closed at any moment, and only ever queried by membership.
  misconduct_types TEXT[]      NOT NULL DEFAULT '{}',
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The two axes the tool filters and orders on.
CREATE INDEX IF NOT EXISTS compliance_actions_org_idx
  ON compliance_actions (LOWER(organisation));

CREATE INDEX IF NOT EXISTS compliance_actions_date_idx
  ON compliance_actions (action_date DESC);

-- Membership tests against the multi-select ("everything tagged Improper Debt
-- Collection") scan the array; GIN makes that an index lookup.
CREATE INDEX IF NOT EXISTS compliance_actions_misconduct_idx
  ON compliance_actions USING GIN (misconduct_types);
