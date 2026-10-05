-- QA-539: RFQ flags gain the same lifecycle listing/quote reports have —
-- 0036 assumed "a spam-mark kills the target, so rows need no status",
-- but the flag queue (QA-479+) also holds flags a moderator judges BOGUS:
-- clearing those without acting on the RFQ needs a real resolved state.
alter table if exists rfq_reports
  add column if not exists status text not null default 'open',
  add column if not exists resolved_at timestamptz;

alter table if exists rfq_reports
  add constraint rfq_reports_status_check check (status in ('open', 'dismissed'));

-- Flags whose target already died retro-dismiss — the queue only reviews
-- what still needs a decision.
update rfq_reports r set status = 'dismissed', resolved_at = now()
  from rfqs q where r.rfq_id = q.id and q.status in ('closed', 'spam');

-- Dedupe becomes open-only like every other report surface: a dismissed
-- flag re-arms, a second open one 409s.
drop index if exists rfq_reports_dedupe;
create unique index if not exists rfq_reports_open_dedupe
  on rfq_reports (rfq_id, reporter_id)
  where status = 'open';
