import {
  analyticsProvider,
  brandedEmailHtml,
  emailProvider,
} from "@jetmarket/providers";
import { CONCIERGE_PRICE_USD, site } from "@jetmarket/config";
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
  // The funnel's only paid-buyer revenue event — amount rides the props so
  // a revenue report needs no join back to config.
  analyticsProvider().track({
    name: "rfq_concierge_paid",
    props: {
      rfqId,
      delivered: res.matches.length,
      amountUsd: CONCIERGE_PRICE_USD,
    },
  });
  const rfq = await repo.getRfq(rfqId);
  if (repoBackend() === "postgres") {
    // Flip recipients get the same quote_notification job the delayed-match
    // sweep enqueues; the sweep also backstops a crash between flip and
    // enqueue (unnotifiedPendingMatches dedupes both paths).
    for (const m of res.matches) {
      try {
        await enqueueJob(getDbSql(), "email.quote_notification",
          { matchId: m.id },
          { vertical: rfq?.vertical },
        );
      } catch (e) {
        logWarn("rfq.concierge_notify_enqueue_failed", {
          rfqId,
          matchId: m.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } else if (res.matches.length && rfq) {
    // Memory mode has no worker — the buyer just paid for instant delivery,
    // so the flipped operators get the same email inline (QA-89 parity).
    const listing = rfq.listingId
      ? await repo.getListing(rfq.listingId)
      : undefined;
    await emailRfqMatches(
      repo,
      rfq,
      listing?.title,
      res.matches.map((m) => m.operatorId),
    );
  }
  // Buyer receipt: the paying buyer is otherwise the only party who hears
  // nothing — operators get priority mail, admin sees revenue, but the $49
  // buyer's only channel is email. Confirm what they bought + deep-link
  // back to the inbox (bearer token in the fragment per AGENTS). Non-fatal.
  if (rfq?.buyerEmail && rfq.accessToken) {
    try {
      const listingTitle = rfq.listingId
        ? (await repo.getListing(rfq.listingId))?.title
        : undefined;
      const title = listingTitle ?? "your request";
      const origin =
        process.env.APP_URL?.replace(/\/+$/, "") ?? `https://${site.domain}`;
      const inboxUrl =
        `${origin}/quotes?email=${encodeURIComponent(rfq.buyerEmail)}` +
        `#t=${encodeURIComponent(rfq.accessToken)}`;
      const delivered = res.matches.length;
      const subject = `Concierge active — “${title}” is in every matching operator's inbox`;
      const paid = `You paid $${CONCIERGE_PRICE_USD} for Concierge expedite on ${site.name}.`;
      const what = delivered > 0
        ? `We just delivered your request for “${title}” to ` +
          `${delivered} matching operator${delivered === 1 ? "" : "s"} — ` +
          `quotes usually follow quickly.`
        : `Your request for “${title}” is already in every matching operator's inbox.`;
      const track = `Track quotes here: ${inboxUrl}`;
      await emailProvider().send({
        to: rfq.buyerEmail,
        subject,
        text: `${paid}\n\n${what}\n\n${track}`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [paid, what, track],
        }),
      });
    } catch (e) {
      logWarn("email.concierge_receipt_failed", {
        rfqId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return true;
}
