import { z } from "zod";
import { site } from "@jetmarket/config";
import { fromMinorUnits, percentOf, toMinorUnits } from "@jetmarket/domain";
import { clientIp, err, isUniqueViolation, ok, parseBody, rateLimit } from "@/lib/api";
import { successFeePctFor } from "@/lib/fees";
import { logWarn } from "@/lib/log";
import { notifyDealClosed, notifyQuoteDeclined } from "@/lib/notify";
import { getRepo } from "@/lib/repo";
import { closeListingRfqs, sweepStaleRfqs } from "@/lib/sweep";
import { paymentsProvider, analyticsProvider } from "@jetmarket/providers";
import { oneOffListingType } from "@jetmarket/verticals";
import { verticalConfig, verticalSlug } from "@/lib/vertical";
import { buyerAuthorized } from "@/lib/buyer-auth";
import { endListingWatches } from "@/lib/search-alerts";
import { appOrigin } from "@/lib/origin";

const Body = z.object({
  buyerEmail: z.string().email().max(254),
  // Per-RFQ bearer token from the buyer's email link (QA-39).
  token: z.string().max(256).optional().default(""),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!rateLimit(`quote-accept:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, Body);
  if (error) return error;

  const repo = await getRepo();
  const quote = await repo.getQuote(id);
  if (!quote) return err("quote not found", 404);
  // Lazy expiry in memory mode (no worker): a stale-yet-'open' RFQ must not
  // mint a deal on a dead request (QA-142).
  await sweepStaleRfqs(repo);
  const rfq = await repo.getRfq(quote.rfqId);
  // Buyer email compares case-insensitively — stored lowercase at create
  // (QA-153), so lowercase the inbound side the same way. Vertical guard
  // keeps shared-DB foreign RFQs from being dealt on this deploy (QA-298).
  if (
    !rfq ||
    rfq.vertical !== verticalSlug() ||
    !(await buyerAuthorized(rfq, data!))
  ) {
    return err("not your quote", 403);
  }
  // The RFQ must still be live — a "sent" quote can outlive its RFQ when the
  // expiry sweep has not ticked yet (pg worker gap between ticks).
  if (!["open", "matched", "quoted"].includes(rfq.status)) {
    return err("rfq is no longer open", 409);
  }
  if (quote.status !== "sent") return err(`quote already ${quote.status}`, 409);
  // The RFQ's listing being archived or sold since the quote was sent must
  // not mint a deal — both states are terminal and the row is gone from the
  // market (QA-300, QA-498). Check BEFORE the CAS so the 409 doesn't flip
  // anything.
  const parentListing = rfq.listingId
    ? await repo.getListing(rfq.listingId)
    : undefined;
  if (
    parentListing?.status === "archived" ||
    parentListing?.status === "sold"
  ) {
    return err("listing is no longer available", 409);
  }
  // QA-471: suspension is enforcement, not a suggestion — a suspended
  // operator's already-sent quotes must not mint NEW deals. Already-sealed
  // deals keep settling; deal formation stops here, BEFORE the CAS, so a
  // rejected accept can't flip the RFQ closed.
  const quotingOp = await repo.getOperator(quote.operatorId);
  if (quotingOp?.suspended) {
    return err("operator unavailable", 409);
  }

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
    return err("rfq is no longer open", 409);
  }
  // Then the quote itself: an accept racing a decline/withdraw on the same
  // quote loses here. Roll the RFQ back so the losing quote's RFQ stays live.
  if (!(await repo.setQuoteStatus(id, "accepted", "sent"))) {
    await repo.setRfqStatus(rfq.id, "quoted", ["closed"]);
    return err("quote already transitioned", 409);
  }
  const listing = parentListing;
  const feePct = listing ? successFeePctFor(listing.type) : 0.03;
  // Fee in integer minor units — float math on majors loses cents at edges,
  // and a hardcoded ×100 invoices a 0-decimal currency at 100× (QA-258).
  const feeMinor = percentOf(
    toMinorUnits(quote.amount, quote.currency),
    feePct * 100,
  );
  const feeAmount = fromMinorUnits(feeMinor, quote.currency);
  let deal;
  try {
    deal = await repo.createDeal({
      quoteId: quote.id,
      operatorId: quote.operatorId,
      amount: quote.amount,
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
      return err("quote already accepted", 409);
    }
    // Transient failure (db blip etc.): roll the CAS flips back so a buyer
    // retry can complete — otherwise the RFQ stays closed with no deal and
    // every retry hits "quote already accepted" (QA-310). Best-effort: if
    // the rollback also fails the datastore is still down anyway.
    try {
      if (await repo.setQuoteStatus(id, "sent", "accepted")) {
        await repo.setRfqStatus(rfq.id, "quoted", ["closed"]);
      }
    } catch (rollbackErr) {
      logWarn("quote.accept_rollback_failed", {
        quoteId: id,
        error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      });
    }
    throw e;
  }

  // Decline the losing sent quotes only AFTER the deal exists — a transient
  // createDeal failure rolls the RFQ+winner back above, and a sibling
  // declined before that point would stay dead (with a "not selected"
  // email) on an RFQ that never closed (QA-392).
  for (const q of await repo.listQuotes({ rfqId: rfq.id })) {
    if (q.id !== id && q.status === "sent") {
      if (await repo.setQuoteStatus(q.id, "declined", "sent")) {
        await notifyQuoteDeclined(repo, q, rfq, "competing-accepted");
      }
    }
  }

  analyticsProvider().track({
    name: "quote_accepted",
    props: { quoteId: quote.id, rfqId: rfq.id, amount: quote.amount },
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
  if (listing && oneOffListingType(verticalConfig(), listing.type)) {
    try {
      await repo.updateListingStatus(listing.id, "sold");
      await endListingWatches(repo, listing, appOrigin(req));
      // QA-499: sibling RFQs on the consumed listing are orphaned — their
      // quotes can never close now. Sweep + decline them (listing-ended).
      await closeListingRfqs(repo, listing, appOrigin(req));
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

  return ok({ quote: await repo.getQuote(id), deal });
}
