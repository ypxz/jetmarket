-- Idempotent RFQ submit: dedupe_key is sha256(listing|email|canonical fields)
-- set by the app at insert. Unique partial index makes concurrent retries and
-- double-submits collide instead of minting duplicate RFQs/fan-outs.
alter table rfqs add column dedupe_key text;
create unique index rfqs_dedupe_key on rfqs (dedupe_key) where dedupe_key is not null;
