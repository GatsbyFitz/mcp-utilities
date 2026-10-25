-- Add the raw dimension columns to an existing aer_performance table.
--
-- `aer_performance.sql` carries these for a fresh install. This file is for a
-- table that already exists, because CREATE TABLE IF NOT EXISTS will not add a
-- column to one. Safe to run either way — every statement is idempotent.
--
-- Why they exist: `retailer`, `jurisdiction` and `fuel` used to hold whatever
-- the cell said. "Origin" and "Origin Energy" were therefore two retailers,
-- and because the observation index keys on the retailer they were two rows
-- that never collided and never deduped — one company's history appearing to
-- stop and another appearing from nowhere. The same bug `metric`/`metric_raw`
-- already prevents, on the other axis.
--
-- Those three columns now hold the canonical key, and `*_raw` holds the string
-- the workbook actually used. Kept forever, so a canonicalisation that turns
-- out wrong is recomputed from what is stored rather than by re-downloading
-- and re-parsing fifty-four workbooks.
--
-- NOTE for an existing table with rows in it: the `retailer`, `jurisdiction`
-- and `fuel` columns of those rows still hold raw strings, and no backfill can
-- canonicalise them faithfully — the raw value was never kept separately, so
-- there is nothing to recompute *from*. Re-ingest the affected quarters
-- instead; `replaceScheduleRows` is idempotent per (schedule, period_label),
-- so re-running a quarter replaces it.
-- See .claude/conventions/data-stores.md.

ALTER TABLE aer_performance ADD COLUMN IF NOT EXISTS retailer_raw     TEXT;
ALTER TABLE aer_performance ADD COLUMN IF NOT EXISTS jurisdiction_raw TEXT;
ALTER TABLE aer_performance ADD COLUMN IF NOT EXISTS fuel_raw         TEXT;

-- "Which spellings has this retailer appeared under" — the question that
-- decides whether two canonical keys are really one company.
CREATE INDEX IF NOT EXISTS aer_performance_retailer_raw_idx
  ON aer_performance (retailer, retailer_raw);
