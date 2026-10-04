-- QA-418: once-per-expiry stamp so the worker's listing-expiry mail can't
-- repeat. NULL = never mailed for this expiry round.
alter table listings add column expiry_mailed_at timestamptz;
