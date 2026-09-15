-- 0001_init — JetMarket core schema (spec §Data model) + jobs queue.
-- Idempotent: every statement is IF NOT EXISTS so partial state converges.

create extension if not exists pgcrypto;

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  role        text not null default 'operator' check (role in ('buyer','operator','admin')),
  created_at  timestamptz not null default now()
);

create table if not exists operators (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  name          text not null,
  base_airport  text,
  fleet_summary text,
  verified      boolean not null default false,
  plan          text not null default 'free',
  created_at    timestamptz not null default now()
);
create index if not exists operators_user_idx on operators(user_id);

create table if not exists listings (
  id           uuid primary key default gen_random_uuid(),
  operator_id  uuid not null references operators(id) on delete cascade,
  vertical     text not null,
  type         text not null,
  title        text not null,
  attributes   jsonb not null default '{}'::jsonb,
  price_minor  bigint,
  currency     text not null default 'USD',
  status       text not null default 'draft'
               check (status in ('draft','active','paused','archived')),
  photos       jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists listings_operator_idx on listings(operator_id);
create index if not exists listings_search_idx on listings(vertical, status, type);
create index if not exists listings_attributes_gin on listings using gin (attributes);

create table if not exists rfqs (
  id          uuid primary key default gen_random_uuid(),
  vertical    text not null,
  listing_id  uuid references listings(id) on delete set null,
  buyer_email text not null,
  fields      jsonb not null default '{}'::jsonb,
  status      text not null default 'new'
              check (status in ('new','matched','quoted','closed','spam')),
  created_at  timestamptz not null default now()
);
create index if not exists rfqs_status_idx on rfqs(status, created_at);

create table if not exists rfq_matches (
  id          uuid primary key default gen_random_uuid(),
  rfq_id      uuid not null references rfqs(id) on delete cascade,
  operator_id uuid not null references operators(id) on delete cascade,
  listing_id  uuid references listings(id) on delete set null,
  state       text not null default 'pending'
              check (state in ('delayed','pending','sent','failed')),
  deliver_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (rfq_id, operator_id)
);
create index if not exists rfq_matches_due_idx on rfq_matches(state, deliver_at);
create index if not exists rfq_matches_operator_idx on rfq_matches(operator_id);

create table if not exists quotes (
  id           uuid primary key default gen_random_uuid(),
  rfq_id       uuid not null references rfqs(id) on delete cascade,
  operator_id  uuid not null references operators(id) on delete cascade,
  amount_minor bigint not null,
  currency     text not null default 'USD',
  message      text,
  status       text not null default 'draft'
               check (status in ('draft','sent','accepted','declined','expired','withdrawn')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (rfq_id, operator_id)
);
create index if not exists quotes_rfq_idx on quotes(rfq_id);

create table if not exists deals (
  id              uuid primary key default gen_random_uuid(),
  quote_id        uuid not null unique references quotes(id) on delete cascade,
  closed_at       timestamptz not null,
  fee_pct         numeric(5,2) not null,
  fee_amount_minor bigint not null,
  currency        text not null default 'USD',
  invoice_status  text not null default 'pending'
                  check (invoice_status in ('pending','invoiced','paid','void')),
  invoice_ref     text
);

create table if not exists subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  operator_id              uuid not null references operators(id) on delete cascade,
  plan                     text not null,
  status                   text not null default 'incomplete'
                           check (status in ('incomplete','trialing','active','past_due','canceled')),
  current_period_end       timestamptz,
  provider_customer_id     text,
  provider_subscription_id text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (operator_id)
);

create table if not exists usage (
  operator_id uuid not null references operators(id) on delete cascade,
  metric      text not null,
  period      text not null default 'all',
  value       integer not null default 0,
  primary key (operator_id, metric, period)
);

-- Background job queue polled by apps/worker (FOR UPDATE SKIP LOCKED claim).
create table if not exists jobs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending'
               check (status in ('pending','running','done','failed')),
  run_at       timestamptz not null default now(),
  attempts     integer not null default 0,
  max_attempts integer not null default 5,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists jobs_claim_idx on jobs(status, run_at);
