-- QA-524: private per-operator note on a visible RFQ — inbox triage has
-- no memory between visits ("called this buyer", "suspicious"). Scoped to
-- (operator, rfq): the note never leaves the operator's own surfaces.
create table if not exists operator_rfq_notes (
  operator_id uuid not null references operators(id) on delete cascade,
  rfq_id uuid not null references rfqs(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (operator_id, rfq_id)
);
