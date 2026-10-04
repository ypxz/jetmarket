-- QA-522: counter-round history. Each buyer counter persists as an audit
-- row — the four lifecycle exits (revise, withdraw, decline, close) resolve
-- its outcome instead of erasing the round, so the buyer sees what became
-- of their counter and the negotiation trail survives.
create table if not exists quote_counter_rounds (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  rfq_id uuid not null references rfqs(id) on delete cascade,
  amount_minor bigint not null,
  -- Denormalized from the quote at counter time: a revise may change the
  -- quote's currency; the counter was denominated in what it carried then.
  currency text not null,
  note text,
  outcome text not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists quote_counter_rounds_quote_id_idx
  on quote_counter_rounds (quote_id);
