-- QA-422: one-shot buyer nudge stamp — the worker mails the buyer once per
-- RFQ that sits 'quoted' with no fresh quote activity past the nudge window.
alter table rfqs
  add column if not exists quote_nudge_mailed_at timestamptz;
