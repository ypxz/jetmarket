-- QA-425: cooldown stamp — the worker mails the operator an "N requests are
-- waiting for your quote" digest at most once per cooldown window while live
-- RFQs sit unanswered in their inbox.
alter table operators
  add column if not exists unanswered_mailed_at timestamptz;
