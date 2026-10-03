-- Saved-search alerts: delivery cadence (QA-406).
-- 'instant' = mail at match time (20h cooldown -> pending_ids batch),
-- 'daily'   = never instant-mail; every match queues pending_ids and the
--             matured-backlog flush (worker searchAlertFlush) sends ONE
--             digest per cooldown window.
ALTER TABLE search_alerts
  ADD COLUMN IF NOT EXISTS freq text NOT NULL DEFAULT 'instant'
    CHECK (freq IN ('instant', 'daily'));
