-- QA-423: one-shot "still working on it" stamp — the worker mails the buyer
-- once per RFQ that sits with zero live quotes past the nudge window.
alter table rfqs
  add column if not exists no_quotes_mailed_at timestamptz;
