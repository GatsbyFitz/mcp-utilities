-- AER retail performance data — Schedules 2, 3 and 4.
--
-- One row per *observation*, not per spreadsheet column. The AER republishes
-- these workbooks every quarter and the layout drifts: columns move, and
-- occasionally a column is renamed. A table shaped like one quarter's columns
-- would need a migration every time that happened, so the metric travels in a
-- column instead of in the schema.
--
-- `metric` vs `metric_raw` is the important pair, and it exists because of the
-- failure that the raw header alone cannot survive. If AER ships
-- "Residential customers" for eight quarters and then "Residential customer
-- numbers", storing only the verbatim header produces two metrics where there
-- is one series: a query for either returns half the history and stops, and
-- the total that `search_aer_performance` promises comes back quietly low.
--   * `metric`     — canonical key, stable across quarters. What you filter on.
--   * `metric_raw` — the header exactly as that workbook wrote it. Kept forever
--                    so a wrong canonicalisation can be recomputed without
--                    re-downloading or re-parsing anything.
--
-- `source_file`, `sheet_name` and `cell_ref` are provenance, not decoration.
-- For regulatory numbers "where did this come from" has to be answerable, and
-- a value that looks wrong has to be traceable to the cell that produced it.
--
-- Like `uploads`, `document_requests`, `ingestion_runs` and
-- `compliance_actions`, this table is not created by application code. Run it
-- once against the provisioned Neon database.
-- See .claude/conventions/data-stores.md.

CREATE TABLE IF NOT EXISTS aer_performance (
  -- 2, 3 or 4. Kept as the AER numbers them rather than renamed to a theme,
  -- because that is how the files are published and cited.
  schedule     SMALLINT    NOT NULL,
  -- "2023-24 Q3", as written on the release.
  period_label TEXT        NOT NULL,
  -- Bounds, so a range query does not have to parse the label.
  period_start DATE        NOT NULL,
  period_end   DATE        NOT NULL,
  retailer     TEXT        NOT NULL,
  -- NSW/VIC/QLD/SA/TAS/ACT, or whatever the sheet actually distinguishes.
  -- Nullable: not every sheet breaks figures down by jurisdiction.
  jurisdiction TEXT,
  -- electricity/gas. Nullable for the same reason.
  fuel         TEXT,
  metric       TEXT        NOT NULL,
  metric_raw   TEXT        NOT NULL,
  value        NUMERIC     NOT NULL,
  source_file  TEXT        NOT NULL,
  sheet_name   TEXT        NOT NULL,
  -- e.g. "E42". The cell this number was read out of.
  cell_ref     TEXT        NOT NULL,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The mapping the model inferred for this sheet, stored verbatim. When a
  -- number looks wrong months later the question is "what did we think this
  -- column meant", and it should be answerable without re-running inference.
  mapping      JSONB
);

-- One observation per dimension combination.
--
-- A unique INDEX rather than a PRIMARY KEY because the key has to COALESCE:
-- a NULL jurisdiction or fuel is a real case (a sheet that does not break the
-- figure down), and NULLs never compare equal, so without COALESCE a re-ingest
-- would duplicate exactly those rows. Postgres does not accept an expression
-- in a PRIMARY KEY — only in an index — which is the whole reason for the
-- shape of this.
CREATE UNIQUE INDEX IF NOT EXISTS aer_performance_observation_idx
  ON aer_performance (schedule, period_label, retailer, metric,
                      COALESCE(jurisdiction, ''), COALESCE(fuel, ''));

-- The tool filters by retailer and by metric far more than anything else.
CREATE INDEX IF NOT EXISTS aer_performance_retailer_idx
  ON aer_performance (LOWER(retailer));
CREATE INDEX IF NOT EXISTS aer_performance_metric_idx
  ON aer_performance (metric);
-- Series queries: one metric for one retailer over time.
CREATE INDEX IF NOT EXISTS aer_performance_series_idx
  ON aer_performance (metric, retailer, period_start);

-- The canonical metric vocabulary, per schedule.
--
-- Separate from the observations because it is what the *next* ingest is shown
-- in order to recognise a renamed column as an existing series rather than a
-- new one. Without it, every quarter would canonicalise in isolation and the
-- rename problem would come straight back.
CREATE TABLE IF NOT EXISTS aer_metrics (
  schedule    SMALLINT    NOT NULL,
  metric      TEXT        NOT NULL,
  -- Every header ever seen for this metric, newest first. The rename trail.
  aliases     TEXT[]      NOT NULL DEFAULT '{}',
  -- When this metric was first introduced, so "new this quarter" is answerable.
  first_seen  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (schedule, metric)
);
