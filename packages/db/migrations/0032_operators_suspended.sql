-- QA-460: operator suspension — a bad-actor toggle stronger than un-verify:
-- hides their supply from public browse, stops new fan-outs, blocks trades.
alter table operators add column suspended boolean not null default false;
