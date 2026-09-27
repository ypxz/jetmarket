-- QA-42 (ported from template a920f91): stale-webhook gate. Provider events
-- are at-least-once and can arrive out of order; last_event_at lets the
-- upsert drop a stale event instead of clobbering the newer sub state.
alter table subscriptions add column last_event_at bigint;
