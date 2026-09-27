-- QA-39: per-RFQ bearer token. Buyer quote lookup + accept/decline were
-- gated on bare buyer_email — anyone who knew (or guessed) the email could
-- read and act on that buyer's quotes. The token rides in the
-- quote-notification email link and the post-submit thanks redirect, so
-- possession of the link = proof of inbox.
alter table rfqs
  add column access_token text not null default gen_random_uuid()::text;
