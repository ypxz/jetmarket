-- QA-469: operator-side abuse signal — buyers flag listings (0033), the
-- operator who actually reads an abusive RFQ had no way to flag it into
-- the same moderation surface. One flag per (rfq, reporter); the flag's
-- lifecycle IS the RFQ's — a spam-mark kills the target, so rows need
-- no status of their own.
create table if not exists rfq_reports (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references rfqs(id) on delete cascade,
  reporter_id uuid not null references users(id) on delete cascade,
  reason text not null,
  note text,
  created_at timestamptz not null default now()
);

create unique index if not exists rfq_reports_dedupe
  on rfq_reports (rfq_id, reporter_id);
