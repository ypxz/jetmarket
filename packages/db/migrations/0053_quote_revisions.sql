-- QA-530: quote revise history. Each row is the SUPERSEDED term-set — the
-- (amount, currency, message) the quote carried right before a revise
-- overwrote it, captured inside reviseQuote's CAS so a raced double-revise
-- can't both log the same prior state or skip one. The live quote row
-- always shows current terms; the trail is these rows newest-first, so the
-- buyer sees "was $24,000 · Oct 2" under the new number — provenance the
-- single 'was revised' mail can't carry.
create table if not exists quote_revisions (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  rfq_id uuid not null references rfqs(id) on delete cascade,
  amount_minor bigint not null,
  -- Denormalized like quote_counter_rounds: a revise can flip the quote's
  -- currency; the superseded terms stay denominated as they were offered.
  currency text not null,
  message text,
  superseded_at timestamptz not null default now()
);
create index if not exists quote_revisions_quote_id_idx
  on quote_revisions (quote_id);
create index if not exists quote_revisions_rfq_id_idx
  on quote_revisions (rfq_id);
