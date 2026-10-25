-- Retailer brand equivalences, recorded by a person.
--
-- `canonicalRetailer` collapses the ways one name is *written* — "AGL Energy
-- Ltd", "AGL Energy Limited", "agl energy" all land on `agl_energy`. It
-- deliberately does not collapse the ways two names *relate*: "origin" and
-- "origin_energy" come out as different keys.
--
-- That restraint is on purpose. Stripping brand words would merge "Origin
-- Energy" to "origin" correctly and turn "EnergyAustralia" into "australia",
-- and a wrongly merged series is worse than a split one — a split shows up as
-- a gap in the history, a merge shows up as nothing at all while quietly
-- adding two companies' customers together.
--
-- So equivalence is a judgement, made once, by someone who knows the market,
-- and recorded here. `canonical` is the key that survives; `alias` is a key
-- `canonicalRetailer` produced that should be folded into it.
--
-- Empty is the correct initial state. Nothing is merged until someone says so,
-- and `GET /api/aerSummary` reports retailer keys that first appear in the
-- latest period so the candidates surface rather than having to be hunted.
--
-- Not created by application code. Ingestion degrades without it: no folding
-- is applied, which is the same behaviour as an empty table.
-- See .claude/conventions/data-stores.md.

CREATE TABLE IF NOT EXISTS aer_retailers (
  -- The key to keep, as canonicalRetailer would produce it.
  canonical  TEXT        NOT NULL,
  -- The key to fold into it.
  alias      TEXT        NOT NULL,
  -- Why, so a merge is auditable and reversible by whoever reads it next.
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (alias)
);

CREATE INDEX IF NOT EXISTS aer_retailers_canonical_idx ON aer_retailers (canonical);
