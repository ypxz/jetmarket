-- QA-555: buyer flags a DEAL (the charter never flew / scam / abuse) —
-- the last unreported marketplace entity: listings, RFQs and quotes all
-- feed moderation; a closed transaction had no flag path, and it's the
-- one where money already moved. Reporter is the RFQ's buyerEmail
-- (bearer-token proven), not a user id — buyers rarely sign in.
create table if not exists deal_reports (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  reporter_email text not null,
  reason text not null,
  note text,
  status text not null default 'open',            -- open | dismissed
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- One open flag per (deal, reporter) — a dismissed report doesn't block
-- a fresh flag (same lifecycle as quote_reports / listing_reports).
create unique index if not exists deal_reports_open_dedupe
  on deal_reports (deal_id, lower(reporter_email))
  where status = 'open';
create index if not exists deal_reports_status_idx
  on deal_reports (status, created_at);
