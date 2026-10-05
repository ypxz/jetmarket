-- QA-536: RFQ amendment trail — each buyer edit (PATCH /api/rfqs/[id])
-- logs the SUPERSEDED fields map so operators can see WHAT changed, not
-- just that an offer predates an edit (QA-485 stale chip). Old-value
-- logging recovers the original spec new-value logging would lose.
create table rfq_amendments (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references rfqs(id) on delete cascade,
  fields jsonb not null,
  amended_at timestamptz not null default now()
);
create index rfq_amendments_rfq_idx on rfq_amendments (rfq_id);
