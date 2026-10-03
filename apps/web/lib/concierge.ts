import { analyticsProvider } from "@jetmarket/providers";
import { enqueueJob } from "@jetmarket/db";
import { emailRfqMatches } from "@/lib/fanout";
import { logInfo, logWarn } from "@/lib/log";
import { repoBackend } from "@/lib/repo";
import { getDbSql } from "@/lib/repo/drizzle";
import type { Repo } from "@/lib/repo/types";

/**
 * A `payment.completed` event for kind=concierge: flip the RFQ's paid flag
 * and deliver every still-delayed fan-out match immediately (the expedite
 * the buyer just paid for). Idempotent — `repo.expediteRfq` CASes the flag,
 * so a replayed webhook or a double-clicked upsell can't charge twice or
 * re-notify (returns false on the second call).
 */
export async function applyConciergePaid(
  repo: Repo,
  rfqId: string,
): Promise<boolean> {
  const res = await repo.expediteRfq(rfqId);
  if (!res.applied) return false;
  logInfo("rfq.concierge_paid", { rfqId, delivered: res.matches.length });
  analyticsProvider().track({
    name: "rfq_concierge_paid",
    props: { rfqId, delivered: res.matches.length },
  });
  if (repoBackend() === "postgres") {
    // Flip recipients get the same quote_notification job the delayed-match
    // sweep enqueues; the sweep also backstops a crash between flip and
    // enqueue (unnotifiedPendingMatches dedupes both paths).
    const vertical = (await repo.getRfq(rfqId))?.vertical;
    for (const m of res.matches) {
      try {
        await enqueueJob(getDbSql(), "email.quote_notification",
          { matchId: m.id },
          { vertical },
        );
      } catch (e) {
        logWarn("rfq.concierge_notify_enqueue_failed", {
          rfqId,
          matchId: m.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } else if (res.matches.length) {
    // Memory mode has no worker — the buyer just paid for instant delivery,
    // so the flipped operators get the same email inline (QA-89 parity).
    const rfq = await repo.getRfq(rfqId);
    const listing = rfq?.listingId
      ? await repo.getListing(rfq.listingId)
      : undefined;
    if (rfq) {
      await emailRfqMatches(
        repo,
        rfq,
        listing?.title,
        res.matches.map((m) => m.operatorId),
      );
    }
  }
  return true;
}
