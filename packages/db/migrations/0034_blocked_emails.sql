-- QA-463: account-level buyer block — the per-RFQ spam mark handles one
-- abusive request, a serial abuser needs the address itself stopped.
-- RFQs file by buyerEmail (unauthenticated), so the block binds the email.
create table if not exists blocked_emails (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  reason text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists blocked_emails_email_uniq
  on blocked_emails (lower(email));
