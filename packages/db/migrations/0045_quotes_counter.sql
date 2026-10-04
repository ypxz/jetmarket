-- QA-511: buyer counter-offer. A sent quote may carry the buyer's
-- counter amount (minor units) + the stamp of when it was made;
-- reviseQuote clears both — a revised offer opens a fresh round.
alter table quotes
  add column counter_amount_minor bigint,
  add column countered_at timestamptz;
