-- QA-508: buyer decline reason (enum key) — ops learn why quotes die.
ALTER TABLE quotes ADD COLUMN decline_reason text;
