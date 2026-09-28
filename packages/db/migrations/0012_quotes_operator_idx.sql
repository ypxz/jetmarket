-- Operator dashboard stats (QA-252): /app runs ~5 countQuotes({operatorId})
-- per load and the operator RFQ inbox joins quotes by operator — without an
-- index each is a seq scan over every quote ever written.
create index quotes_operator_idx on quotes (operator_id);
