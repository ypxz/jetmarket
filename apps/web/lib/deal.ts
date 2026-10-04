import { site } from "@jetmarket/config";
import { fromMinorUnits, percentOf, toMinorUnits } from "@jetmarket/domain";
import { isUniqueViolation } from "@/lib/api";
import { successFeePctFor } from "@/lib/fees";
import { logWarn } from "@/lib/log";
import { notifyDealClosed, notifyQuoteDeclined } from "@/lib/notify";
import type { Deal, Listing, Quote, Repo, Rfq } from "@/lib/repo/types";
import { closeListingRfqs } from "@/lib/sweep";
import { paymentsProvider, analyticsProvider } from "@jetmarket/providers";
import { oneOffListingType } from "@jetmarket/verticals";
import { verticalConfig } from "@/lib/vertical";
import { endListingWatches } from "@/lib/search-alerts";

export type DealClose =
  | { deal: Deal; error?: undefined }
  | { deal?: undefined; error: { msg: string; status: number } };

/**
 * Deal formation shared by the buyer accept route and the operator's
 * accept-the-counter route (QA-515). `amount` is the agreed price in
 * display units — `quote.amount` on a buyer accept, `quote.counterAmount`
 * when the operator takes the buyer's number. Callers do the actor
 * guards (buyer bearer vs operator session) and the market guards (RFQ
 * live, quote 'sent', listing sellable) BEFORE this runs; the CAS order
 * inside is the arbitration — see comments.
 */
export async function closeDealForQuote(args: {
  repo: Repo;
  quote: Quote;
  rfq: Rfq;
  listing: Listing | undefined;
  amount: number;
  origin: string;
}): Promise<DealClose> {
  const { repo, quote, rfq, listing, amount, origin } = args;
  // Arbitration order matters: the RFQ flip is the single-winner gate.
  // Two accepts on DIFFERENT quotes of this RFQ would both pass their own
  // quote CAS — but only the first can flip the RFQ out of its live states,
  // so at most one deal is ever created per RFQ (QA-99).
  if (
    !(await repo.setRfqStatus(rfq.id, "closed", [
      "open",
      "matched",
      "quoted",
    ]))
  ) {
    return { error: { msg: "rfq is no longer open", status: 409 } };
  }
  // Then the quote itself: an accept racing a decline/withdraw on the same
  // quote loses here. Roll the RFQ back so the losing quote's RFQ stays live.
  if (!(await repo.setQuoteStatus(quote.id, "accepted", "sent"))) {
    await repo.setRfqStatus(rfq.id, "quoted", ["closed"]);
    return { error: { msg: "quote already transitioned", status: 409 } };
  }
  const feePct = listing ? successFeePctFor(listing.type) : 0.03;
  // Fee in integer minor units — float math on majors loses cents at edges,
  // and a hardcoded ×100 invoices a 0-decimal currency at 100× (QA-258).
  const feeMinor = percentOf(
    toMinorUnits(amount, quote.currency),
    feePct * 100,
  );
  const feeAmount = fromMinorUnits(feeMinor, quote.currency);
  let deal;
  try {
    deal = await repo.createDeal({
      quoteId: quote.id,
      operatorId: quote.operatorId,
      amount,
      currency: quote.currency,
      feePct,
      feeAmount,
      invoiceStatus: "pending",
    });
  } catch (e) {
    // Duplicate accept raced past the "sent" check: deals.quote_id unique
    // (db) / guard (memory) rejects the second deal — tell the buyer cleanly.
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("deal already exists") || isUniqueViolation(e)) {
      return { error: { msg: "quote already accepted", status: 409 } };
    }
    // Transient failure (db blip etc.): roll the CAS flips back so a buyer
    // retry can complete — otherwise the RFQ stays closed with no deal and
    // every retry hits "quote already accepted" (QA-310). Best-effort: if
    // the rollback also fails the datastore is still down anyway.
    try {
      if (await repo.setQuoteStatus(quote.id, "sent", "accepted")) {
        await repo.setRfqStatus(rfq.id, "quoted", ["closed"]);
      }
    } catch (rollbackErr) {
      logWarn("quote.accept_rollback_failed", {
        quoteId: quote.id,
        error:
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr),
      });
    }
    throw e;
  }

  // Decline the losing sent quotes only AFTER the deal exists — a transient
  // createDeal failure rolls the RFQ+winner back above, and a sibling
  // declined before that point would stay dead (with a "not selected"
  // email) on an RFQ that never closed (QA-392).
  for (const q of await repo.listQuotes({ rfqId: rfq.id })) {
    if (q.id !== quote.id && q.status === "sent") {
      if (await repo.setQuoteStatus(q.id, "declined", "sent")) {
        await notifyQuoteDeclined(repo, q, rfq, "competing-accepted");
      }
    }
  }

  analyticsProvider().track({
    name: "quote_accepted",
    props: { quoteId: quote.id, rfqId: rfq.id, amount },
  });
  analyticsProvider().track({
    name: "deal_closed",
    props: {
      dealId: deal.id,
      quoteId: quote.id,
      feeAmount: deal.feeAmount,
      feePct: deal.feePct,
    },
  });

  // Success-fee invoice via the payments adapter. A provider hiccup never
  // blocks the accept — the deal stays invoiceStatus "pending" for retry.
  try {
    const invoice = await paymentsProvider().createInvoice({
      customerId: quote.operatorId,
      amountMinor: feeMinor,
      currency: quote.currency,
      description: `${site.name} success fee — deal ${deal.id}`,
      idempotencyKey: deal.id,
      // kind tags the settle event for applyPaymentEvent — the operator
      // pays this invoice through the hosted page (QA-450).
      metadata: { kind: "dealFee", dealId: deal.id, quoteId: quote.id },
    });
    // pending→invoiced, idempotent on retry (a repeat accept re-invoices
    // and refreshes the ref) but never resurrects paid/void (QA-145).
    // invoiceUrl (QA-450): the hosted pay page rides the deal row so the
    // operator's dashboard can link to it without a provider round-trip.
    const flipped = await repo.setDealInvoice(
      deal.id,
      "invoiced",
      invoice.id,
      ["pending", "invoiced"],
      invoice.hostedUrl,
    );
    if (flipped) {
      deal.invoiceStatus = "invoiced";
      deal.invoiceRef = invoice.id;
    }
  } catch (e) {
    logWarn("invoice.create_failed", {
      dealId: deal.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // Winner + buyer confirmations (QA-149); internally failure-safe.
  await notifyDealClosed(repo, quote, rfq, deal);

  // One-off inventory is consumed by the deal (QA-498): an empty leg's seat
  // or an aircraft for sale can't be sold twice, so the listing leaves the
  // market and its saved searches end with a "sold" notice — same terminal
  // treatment as archive, with 'sold' recording WHY. Capacity types
  // (charter) skip this: one plane takes many charters.
  // QA-502: only the LISTING OWNER's winning quote consumes the pinned
  // listing — a fan-out win means the buyer chose another operator's
  // supply; the pinned listing is still on the market.
  if (
    listing &&
    quote.operatorId === listing.operatorId &&
    oneOffListingType(verticalConfig(), listing.type)
  ) {
    try {
      await repo.updateListingStatus(listing.id, "sold");
      await endListingWatches(repo, listing, origin);
      // QA-499: sibling RFQs on the consumed listing are orphaned — their
      // quotes can never close now. Sweep + decline them (listing-ended).
      await closeListingRfqs(repo, listing, origin);
      // QA-501: the market-side transition is as observable as the deal.
      analyticsProvider().track({
        name: "listing_status_changed",
        props: {
          listingId: listing.id,
          type: listing.type,
          from: "active",
          to: "sold",
          source: "deal",
          dealId: deal.id,
        },
      });
    } catch (e) {
      // Non-fatal like notify: the deal is already minted — a missed flip
      // leaves the listing browsable but unsellable (the guard above still
      // rejects a second deal attempt once the row is sold).
      logWarn("listing.sold_flip_failed", {
        listingId: listing.id,
        dealId: deal.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { deal };
}
