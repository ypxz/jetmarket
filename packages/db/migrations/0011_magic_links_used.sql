-- Magic-link single-use ledger (QA-250): consumed signatures live in the db
-- instead of process memory — a restart can no longer re-arm a used link and a
-- multi-instance deploy keeps one-shot semantics. Rows self-expire with the
-- link's own TTL and are pruned on write.
create table magic_links_used (
  sig text primary key,
  expires_at timestamptz not null
);
