-- QA-451: buyer deal rating (1-5, once-ever) — the trust signal on quote
-- cards: "★ 4.6 · 12 ratings" beside dealsClosed.
alter table deals add column if not exists buyer_rating smallint;
alter table deals add column if not exists buyer_rated_at timestamptz;
