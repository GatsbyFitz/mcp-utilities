-- What each AER metric actually counts, and when that changed.
--
-- `aer_metrics.aliases` survives a column being *renamed*. It cannot survive a
-- column keeping its name while its meaning moves — if "Disconnections" stays
-- "Disconnections" and the AER changes what counts as one, no name matching
-- notices, and until now nothing in the data could. The definition was never
-- in the data: the AER states it in the workbook's notes and in the reporting
-- guidelines, and the pipeline read past it.
--
-- The primary key is the point. It includes `definition_key`, a hash of the
-- normalised definition text, so a metric accumulates one row per *distinct*
-- definition it has ever had. A second row appearing for a metric that already
-- had one is the event that was previously invisible, and it is not
-- recoverable after the fact: next quarter's workbook states only the new
-- definition, so a quarter that goes uncaptured takes the old wording with it.
--
-- Normalised before hashing, so reflowed whitespace, a changed quote style or
-- a different trailing full stop is not a change. Those happen every quarter
-- and mean nothing; counting them would bury the one that means something.
--
-- Provenance is not optional here. The definition text is extracted from the
-- sheet by the same model call that infers the column mapping, so `source_file`
-- / `sheet_name` / `cell_ref` are what make a stored definition checkable
-- against the workbook that stated it. A definition nobody can trace back is
-- prose about a regulatory measure with no authority behind it.
--
-- Not created by application code, like every other table here. Ingestion
-- degrades without it: `lib/aerDefinitions.ts` recognises the missing table and
-- the run still stores its observations, it simply captures no definitions.
-- See .claude/conventions/data-stores.md.

CREATE TABLE IF NOT EXISTS aer_metric_definitions (
  schedule       SMALLINT    NOT NULL,
  -- The canonical metric key, matching aer_performance.metric.
  metric         TEXT        NOT NULL,
  -- Verbatim as the workbook stated it. Never paraphrased.
  definition     TEXT        NOT NULL,
  -- Hash of the normalised definition. Identity of the *content*.
  definition_key TEXT        NOT NULL,
  -- Period label of the first and most recent workbook to state it, so a
  -- definition's span is answerable: which quarters used which meaning.
  first_seen     TEXT        NOT NULL,
  last_seen      TEXT        NOT NULL,
  source_file    TEXT        NOT NULL,
  sheet_name     TEXT        NOT NULL,
  -- The cell the text was read from, where the sheet gives one.
  cell_ref       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (schedule, metric, definition_key)
);

-- "What does this metric mean" and "has it ever changed" are the two queries.
CREATE INDEX IF NOT EXISTS aer_metric_definitions_metric_idx
  ON aer_metric_definitions (schedule, metric, last_seen DESC);
