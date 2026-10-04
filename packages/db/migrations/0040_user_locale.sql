-- QA-494: operator/admin-facing mail locale — the user's sign-in locale.
-- Stamped/adopted at magic-link request time (the POST body carries
-- `locale` because API paths sit outside next-intl middleware); all
-- operator-facing mails (fanout, nudges, moderation, invoices) render in
-- it. Buyer-facing artifacts keep their own stamps (0039).
ALTER TABLE users ADD COLUMN locale varchar NOT NULL DEFAULT 'en';
