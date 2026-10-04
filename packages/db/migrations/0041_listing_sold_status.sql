-- QA-498: 'sold' — terminal like 'archived' but records WHY the row left the
-- market: a closed deal consumed a one-off listing (empty_leg, aircraft_sale,
-- for_sale, auction). CHECK is DB-level, so widen it in place.

alter table listings drop constraint listings_status_check;
alter table listings
  add constraint listings_status_check
  check (status in ('draft','active','paused','archived','sold'));
