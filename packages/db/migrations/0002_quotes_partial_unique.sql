-- QA-18: allow re-quoting after decline/withdraw. The blanket
-- unique(rfq_id, operator_id) made every second quote from an operator
-- collide (500). One *live* quote per (rfq, operator) is the real
-- invariant — enforce it as a partial unique index over the live
-- statuses ('sent','accepted'); terminal rows (declined/withdrawn/
-- expired/accepted->closed siblings) no longer count.
alter table quotes drop constraint quotes_rfq_id_operator_id_key;

create unique index quotes_rfq_operator_live_uniq
  on quotes (rfq_id, operator_id)
  where status in ('sent', 'accepted');
