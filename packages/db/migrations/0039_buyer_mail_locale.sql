-- QA-493: recipient locale stamped on mail-triggering artifacts. Routes
-- can't see the page locale (API paths skip the next-intl middleware), so
-- forms carry it in the POST body and the artifact keeps it — buyer-facing
-- notification mails render in the same catalog the user browsed under.
-- Operator mails (users.*) come later — QA-494.
ALTER TABLE rfqs ADD COLUMN locale varchar NOT NULL DEFAULT 'en';
ALTER TABLE search_alerts ADD COLUMN locale varchar NOT NULL DEFAULT 'en';
