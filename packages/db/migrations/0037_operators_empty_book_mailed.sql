-- QA-477: empty-book nudge — an operator who signs up and never lists gets
-- no follow-up anywhere in the lifecycle. One once-ever stamp per operator:
-- past the grace window with zero in-vertical listings, one "create your
-- first listing" mail, then silent forever (they either listed or churned —
-- a drip campaign for an empty book is spam).
alter table operators
  add column if not exists empty_book_mailed_at timestamptz;
