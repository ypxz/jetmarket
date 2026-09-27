-- QA-90: buyer quote-page lookups filter rfqs by buyer_email ordered by
-- created_at desc — without an index that is a seq scan on every view.
create index if not exists rfqs_buyer_idx on rfqs (buyer_email, created_at desc);
