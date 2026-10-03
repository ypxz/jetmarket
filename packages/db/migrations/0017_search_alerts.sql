-- Saved-search alerts (QA-403): a buyer saves a /search filter set and gets
-- emailed when new matching listings go active. `params` stores the raw URL
-- params — the same whitelisted mapping the search page uses re-applies them
-- (listingFilterFor), so an alert can never probe arbitrary jsonb paths.
-- `token` is the confirm + unsubscribe bearer; `dedupe_key` is a hash of
-- (vertical, email, canonical params) so re-subscribing rotates the token on
-- the SAME row instead of stacking duplicates. `pending_ids` queues matched
-- listings during the per-alert mail cooldown and ships with the next digest.
create table search_alerts (
  id uuid primary key default gen_random_uuid(),
  vertical text not null,
  email text not null,
  params jsonb not null default '{}',
  token text not null unique,
  dedupe_key text not null unique,
  status text not null default 'pending' check (status in ('pending','active','off')),
  pending_ids jsonb not null default '[]',
  last_alerted_at timestamptz,
  created_at timestamptz not null default now()
);

create index search_alerts_due_idx
  on search_alerts (vertical, status, last_alerted_at)
  where status = 'active';
