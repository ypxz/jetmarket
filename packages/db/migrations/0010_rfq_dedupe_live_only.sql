-- Live-only RFQ dedupe (QA-228): a buyer resubmitting the same request after
-- the previous RFQ closed/spam'd used to replay the dead row — the operator
-- never saw the re-inquiry. The unique index now collides only while a twin
-- is live; getRfqByDedupeKey reads the same live set.
drop index if exists rfqs_dedupe_key;
create unique index rfqs_dedupe_key on rfqs (dedupe_key)
  where dedupe_key is not null and status in ('new', 'matched', 'quoted');
