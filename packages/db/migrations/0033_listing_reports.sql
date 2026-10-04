-- QA-461: buyer flags on listings — admin reviews the queue, then acts via
-- the existing moderation (archive/pause) or suspension tools. Reports die
-- with their listing (cascade) and with their reporter.
create table if not exists listing_reports (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  reporter_id uuid not null references users(id) on delete cascade,
  reason text not null,
  note text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- One open report per reporter per listing — a second flag is a 409, not a
-- duplicate queue row. Closed reports don't block a fresh flag.
create unique index if not exists listing_reports_open_dedupe
  on listing_reports (listing_id, reporter_id)
  where status = 'open';

create index if not exists listing_reports_status_idx
  on listing_reports (status, created_at desc);
