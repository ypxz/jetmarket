-- QA-456: worker "how was your deal?" nudge — once-per-deal stamp so a
-- buyer who skipped the close-mail rate link gets asked exactly once.
alter table deals
  add column rating_mailed_at timestamptz;
