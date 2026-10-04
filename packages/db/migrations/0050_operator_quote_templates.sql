-- QA-527: operator quote templates — saved (name, amount, message) presets an
-- operator can drop into the RFQ inbox quote form. Amount is stored in
-- DISPLAY units (numeric) because templates are currency-agnostic: the quote
-- picks up the listing's currency at send time, so minor units would need a
-- fake currency to convert.
create table operator_quote_templates (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references operators(id) on delete cascade,
  name text not null,
  amount numeric(14, 2) not null,
  message text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, name)
);

create index operator_quote_templates_operator_idx
  on operator_quote_templates(operator_id);
