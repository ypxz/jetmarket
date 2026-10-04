-- QA-516: one-shot stamp — the worker nudges the operator once when a
-- buyer's counter sits unanswered past the nudge window (a hot lead
-- going cold). Once-ever per counter round; reviseQuote clears the
-- counter itself so a re-countered round can re-arm.
alter table quotes
  add column if not exists counter_nudge_mailed_at timestamptz;
