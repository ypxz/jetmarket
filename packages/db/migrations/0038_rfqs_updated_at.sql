-- QA-482: rfqs.updated_at — "the request content changed" stamp. Buyers
-- can amend live requests (QA-481); operators need to tell an updated
-- request apart from the one they first saw (updated_at > their match's
-- deliver_at => "Updated" badge). Also satisfies the repo rule that
-- content writes bump updated_at.
ALTER TABLE rfqs ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
