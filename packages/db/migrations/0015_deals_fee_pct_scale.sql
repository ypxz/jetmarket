-- QA-386: fee_pct numeric(5,2) silently rounded fractional fee rates —
-- a 1.5% (0.015) aircraft_sale fee was stored as 0.02 while the invoiced
-- amount had been computed from the true rate. Widen the scale and repair
-- existing rows by recomputing the rate from the invoiced minor amount.
ALTER TABLE deals ALTER COLUMN fee_pct TYPE numeric(6,4);
UPDATE deals d SET fee_pct = d.fee_amount_minor::numeric / q.amount_minor
  FROM quotes q WHERE q.id = d.quote_id AND q.amount_minor > 0;
