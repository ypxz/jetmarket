-- QA-450: the provider invoice's hosted pay URL — the operator pays the
-- success fee through it (mock: fabricated payment.completed; stripe:
-- hosted_invoice_url → invoice.paid webhook).
alter table deals add column if not exists invoice_url text;
