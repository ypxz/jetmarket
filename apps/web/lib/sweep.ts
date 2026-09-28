import type { Repo } from "./repo/types";

/**
 * Lazy RFQ expiry sweep. The worker ticks every 5s in postgres mode, but
 * memory mode has no worker — without this a stale RFQ stays "open" forever
 * and keeps accepting/closing quotes (QA-142). Run it on the routes where an
 * RFQ's live state gates a mutation or a buyer/operator inbox read.
 *
 * Memory mode only: in pg the worker's detailed sweep owns expiry because it
 * also sends the buyer/operator notification emails — sweeping here first
 * would flip the rows and silently skip those notifications.
 */
export async function sweepStaleRfqs(repo: Repo): Promise<void> {
  if (process.env.REPO === "postgres" || process.env.DATABASE_URL) return;
  await repo.expireRfqs(new Date().toISOString());
}
