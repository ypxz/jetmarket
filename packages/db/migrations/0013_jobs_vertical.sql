-- Shared-DB isolation (QA-295): when two verticals run against one database,
-- each deploy's worker must only claim its own jobs. NULL = unscoped/legacy,
-- claimable by any worker so pre-migration rows are never stranded.
alter table jobs add column if not exists vertical text;
