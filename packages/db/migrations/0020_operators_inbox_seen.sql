-- QA-416: operator inbox "New" marker — inbox_seen_at stamps the last time
-- /app/rfqs rendered for this operator; rows newer than it badge "New".
-- One timestamp covers owned and fan-out-matched RFQs alike (owned rows
-- have no rfq_matches row to hang per-row state on by design — self-match
-- is excluded from fan-out).
alter table operators add column inbox_seen_at timestamptz;
