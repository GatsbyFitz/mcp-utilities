-- Customer segment, release provenance, and a wider observation key.
--
-- Run this after db/aer_performance.sql and
-- db/aer_performance_raw_dimensions.sql. Every statement is idempotent.
--
-- WHY. The first real workbook was nothing like the shape the table assumed.
-- A Schedule 2 sheet is:
--
--   row 3:  Q4 2022-23 to Q4 2023-24 | Electricity      | Residential
--   row 4:  National                 | Customer numbers | Customer numbers | ...
--   row 5:  Retailer                 | Q4 2022-23       | Q1 2023-24       | ...
--   row 6:  1st Energy               | 25576            | 25240            | ...
--
-- Two things follow, and both need schema:
--
-- 1. **The columns are quarters.** One workbook carries about five, so a
--    period is a property of the column a number came from, not of the
--    workbook. `release_label` records which publication stated it, because
--    consecutive releases overlap by four quarters and a later one restates
--    the earlier ones. Without it, "which release does this number come from"
--    is unanswerable.
--
-- 2. **Customer segment is a dimension**, stated in a cell above the table
--    (`C3`) and varying by sheet: Residential, Small Business, Large. The
--    observation index did not include it, so those three sheets shared
--    `(schedule, period_label, retailer, metric, jurisdiction, fuel)` and
--    silently overwrote each other — three segments collapsing to whichever
--    sheet was parsed last.
--
-- The index is replaced rather than added to, since a UNIQUE index that omits
-- a real dimension is not a weaker constraint but a wrong one.
-- See .claude/conventions/data-stores.md.

ALTER TABLE aer_performance ADD COLUMN IF NOT EXISTS customer_type     TEXT;
ALTER TABLE aer_performance ADD COLUMN IF NOT EXISTS customer_type_raw TEXT;
-- Which published workbook this number was read out of, e.g. "2023-24 Q4".
ALTER TABLE aer_performance ADD COLUMN IF NOT EXISTS release_label     TEXT;

-- One observation per dimension combination, now including the segment.
-- Dropped and recreated: the old index would keep three customer segments
-- colliding.
DROP INDEX IF EXISTS aer_performance_observation_idx;
CREATE UNIQUE INDEX IF NOT EXISTS aer_performance_observation_idx
  ON aer_performance (schedule, period_label, retailer, metric,
                      COALESCE(jurisdiction, ''), COALESCE(fuel, ''),
                      COALESCE(customer_type, ''));

-- "What did this release change" — the query that makes a restatement visible.
CREATE INDEX IF NOT EXISTS aer_performance_release_idx
  ON aer_performance (schedule, release_label);
