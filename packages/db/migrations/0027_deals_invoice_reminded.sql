-- QA-429: overdue-invoice reminder stamp — doubles as the 7d mail cooldown.
alter table deals
  add column if not exists invoice_reminded_at timestamptz;
