create table if not exists rfq_dismissals (
  rfq_id uuid not null references rfqs(id) on delete cascade,
  operator_id uuid not null references operators(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (rfq_id, operator_id)
);
