-- QA-521: the buyer can attach one line to their counter — the number
-- alone can't carry "that's with positioning included". Clears with
-- the rest of the counter round (revise/withdraw/decline).
alter table quotes add column if not exists counter_message text;
