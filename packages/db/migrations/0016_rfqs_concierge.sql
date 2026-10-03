-- Buyer concierge ($49/request): a paid flag that expedites the RFQ — its
-- delayed fan-out matches are flipped to pending immediately instead of
-- waiting out the free-plan delay window.
alter table rfqs add column concierge boolean not null default false;
