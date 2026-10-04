-- QA-447: one-shot "closing soon" stamp — the worker mails the buyer once
-- per RFQ that enters its liveness window (QA-442 horizon) while still live.
alter table rfqs
  add column if not exists closing_mailed_at timestamptz;
