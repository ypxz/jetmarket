-- QA-314: buyer-inbox bearer token must be unique — a collision (callers can
-- supply accessToken, e.g. the per-vertical demo seeds) would
-- cross-authenticate two RFQ inboxes. Invariant pin for QA-39's auth model.
create unique index rfqs_access_token_key on rfqs (access_token);
