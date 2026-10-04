-- QA-467: moderation audit trail — every admin enforcement write was
-- logInfo-only: auditable in logs, invisible in-app. One append-only
-- table the admin page renders; `vertical` scopes it like every
-- moderation surface (a shared DB hosts other deploys' queues).
create table if not exists admin_events (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references users(id) on delete set null,
  event text not null,
  target_type text not null,
  target_id text not null,
  meta jsonb,
  vertical text not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_events_feed_idx
  on admin_events (vertical, created_at desc);
