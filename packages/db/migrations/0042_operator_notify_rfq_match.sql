-- QA-505: per-operator opt-out for RFQ-match notification mails. Inbox rows
-- still land (visibility ≠ mail volume); only the email leg is muted.
ALTER TABLE operators
  ADD COLUMN notify_rfq_match boolean NOT NULL DEFAULT true;
