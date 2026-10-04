import { repoBackend } from "./repo";
import type { Listing, Repo } from "./repo/types";
import { verticalSlug } from "./vertical";
import { notifyBuyerRfqEnded, notifyQuoteDeclined } from "./notify";

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
  // Key off the resolved backend, not the raw env: `REPO=memory` must sweep
  // even when a DATABASE_URL leaks into the process env (e.g. `pnpm test:all`
  // invoked under an exported dev URL — QA-277).
  if (repoBackend() !== "memory") return;
  await repo.expireRfqs(new Date().toISOString(), verticalSlug());
}

/**
 * QA-499: a terminal listing flip (sold on deal close or manual mark,
 * archived by the operator) orphans every live RFQ pinned to it — quotes
 * on those requests can never mint a deal, so letting them run only means
 * operators quote into a dead request and buyers wait for a reply that
 * can't pay off. Close the orphans in one bulk flip, decline their sent
 * quotes, and mail each operator with the `listing-ended` reason — the
 * notification path is failure-safe (never fails the caller's mutation).
 *
 * Called on every transition INTO a terminal listing status; a pause is
 * not terminal and deliberately doesn't sweep. `origin` feeds the buyer
 * mail's browse-similar CTA (QA-500 — the buyer didn't close the request,
 * so they get told why it died).
 */
export async function closeListingRfqs(
  repo: Repo,
  listing: Listing,
  origin: string,
): Promise<void> {
  const orphans = await repo.closeLiveRfqsForListing(listing.id);
  for (const rfq of orphans) {
    for (const quote of await repo.listQuotes({ rfqId: rfq.id })) {
      if (
        quote.status === "sent" &&
        (await repo.setQuoteStatus(quote.id, "declined", "sent"))
      ) {
        await notifyQuoteDeclined(repo, quote, rfq, "listing-ended");
      }
    }
    await notifyBuyerRfqEnded(rfq, listing, origin);
  }
}
