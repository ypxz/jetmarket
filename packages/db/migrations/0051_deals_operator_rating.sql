-- QA-528: operator→buyer rating — the trust loop's missing half. The
-- buyer's rating (buyer_rating) flows into the operator's public ★ record;
-- the operator's rating never left the deal. Aggregate per buyer email is
-- what the inbox reads to mark "rated buyer" on fresh RFQs.
alter table deals
  add column operator_rating smallint,
  add column operator_rated_at timestamptz;
