-- QA-529: buyer flags a quote (fee-circumvention / scam / abuse) — the
-- report surface the demand side still lacked. Reporter is the RFQ's
-- buyerEmail (bearer-token proven), not a user id — buyers rarely sign in.
create table if not exists quote_reports (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  reporter_email text not null,
  reason text not null,
  note text,
  status text not null default 'open',            -- open | dismissed
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- One open flag per (quote, reporter) — a dismissed report doesn't block
-- a fresh flag (same lifecycle as listing_reports).
create unique index if not exists quote_reports_open_dedupe
  on quote_reports (quote_id, lower(reporter_email))
  where status = 'open';
create index if not exists quote_reports_status_idx
  on quote_reports (status, created_at);
