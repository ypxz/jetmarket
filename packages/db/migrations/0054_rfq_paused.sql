-- Buyer RFQ pause (QA-533): pause freezes NEW offer intake — existing quotes
-- stay acceptable/declinable, the request keeps its natural deadline and the
-- live-status set is untouched. NULL = accepting offers.
alter table rfqs add column paused_at timestamptz;
