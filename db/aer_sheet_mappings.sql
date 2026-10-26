-- What we thought each column meant.
--
-- Run this by hand, like every other file here. Nothing in this repo creates a
-- table.
--
-- This started as a `mapping JSONB` column on `aer_performance`, and the
-- comment on it said "the mapping the model inferred for this sheet". It was
-- not that. `extractAndStore` passed the whole workbook's mappings array, so
-- every one of 45,876 Schedule 2 rows carried all fourteen sheets' mappings —
-- the same JSON, tens of kilobytes of it, repeated once per observation.
--
-- That filled the 1 GB Neon project. The next ingest died on
-- `could not extend file because project size limit (1024 MB) has been
-- exceeded`, after three retries, having spent the storage on roughly 45,000
-- duplicate copies of one object. Nothing ever read the column back.
--
-- A mapping exists once per sheet, so it is stored once per sheet. And no new
-- column is needed on `aer_performance`: `source_file` and `sheet_name` are
-- already on every row, which is exactly the key a mapping belongs to, so a
-- row joins to the mapping that produced it and the provenance question —
-- "what did we think column E meant" — is answered more precisely than
-- before, against that sheet's mapping rather than all of them.

CREATE TABLE IF NOT EXISTS aer_sheet_mappings (
  source_file  TEXT        NOT NULL,
  sheet_name   TEXT        NOT NULL,
  schedule     SMALLINT    NOT NULL,
  -- The mapping as the model returned it, verbatim: metricRow, periodRow, the
  -- dimension columns, and every metric column with its raw header and the
  -- canonical key it was assigned.
  mapping      JSONB       NOT NULL,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One mapping per sheet of a workbook. Re-ingesting a corrected workbook
-- replaces it rather than accumulating a copy per run, which is the same
-- discipline `replaceScheduleRows` follows for the observations themselves.
CREATE UNIQUE INDEX IF NOT EXISTS aer_sheet_mappings_sheet_idx
  ON aer_sheet_mappings (source_file, sheet_name);

-- The column this table replaces. Dropping it is what reclaims the space.
--
-- Postgres does not return a dropped column's TOAST storage until the table is
-- rewritten, and `VACUUM FULL` needs room for a second copy — which a project
-- already at its ceiling does not have. So truncate first. That is safe here
-- and not a loss: every row has to be re-ingested anyway, because the `%` fix
-- to `canonicalMetric` changes the key of every percentage metric.
--
--   TRUNCATE aer_performance;
--
-- Left commented deliberately. It is the one statement in this directory that
-- destroys data, and a file that can be re-run should not carry it.
ALTER TABLE aer_performance DROP COLUMN IF EXISTS mapping;
