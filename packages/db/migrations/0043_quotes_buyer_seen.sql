-- QA-506: buyer read receipts — stamped when the buyer's inbox GET renders
-- the quote; cleared on revise (new content = unseen again).
ALTER TABLE quotes
  ADD COLUMN buyer_seen_at timestamptz;
