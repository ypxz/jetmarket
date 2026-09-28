import { z } from "zod";
import { site } from "@jetmarket/config";
import { clientIp, err, isUniqueViolation, ok, parseBody, rateLimit } from "@/lib/api";
import { successFeePctFor } from "@/lib/fees";
import { logWarn } from "@/lib/log";
import { notifyDealClosed, notifyQuoteDeclined } from "@/lib/notify";
import { getRepo } from "@/lib/repo";
import { sweepStaleRfqs } from "@/lib/sweep";
import { paymentsProvider, analyticsProvider } from "@jetmarket/providers";

const Body = z.object({
  buyerEmail: z.string().email().max(254),
  // Per-RFQ bearer token from the buyer's email link (QA-39).
  token: z.string().min(1).max(256),
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
  if (
    !rfq ||
    rfq.buyerEmail !== data!.buyerEmail ||
    rfq.accessToken !== data!.token
  ) {
    return err("not your quote", 403);
  }
  // The RFQ must still be live — a "sent" quote can outlive its RFQ when the
  // expiry sweep has not ticked yet (pg worker gap between ticks).
  if (!["open", "matched", "quoted"].includes(rfq.status)) {
    return err("rfq is no longer open", 409);
  }
  if (quote.status !== "sent") return err(`quote already ${quote.status}`, 409);

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
  for (const q of await repo.listQuotes({ rfqId: rfq.id })) {
    if (q.id !== id && q.status === "sent") {
      if (await repo.setQuoteStatus(q.id, "declined", "sent")) {
        await notifyQuoteDeclined(repo, q, rfq, "competing-accepted");
      }
    }
  }

  const listing = await repo.getListing(rfq.listingId);
  const feePct = listing ? successFeePctFor(listing.type) : 0.03;
  let deal;
  try {
    deal = await repo.createDeal({
      quoteId: quote.id,
      operatorId: quote.operatorId,
      amount: quote.amount,
      feePct,
      feeAmount: Math.round(quote.amount * feePct * 100) / 100,
      invoiceStatus: "pending",
    });
  } catch (e) {
    // Duplicate accept raced past the "sent" check: deals.quote_id unique
    // (db) / guard (memory) rejects the second deal — tell the buyer cleanly.
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("deal already exists") || isUniqueViolation(e)) {
      return err("quote already accepted", 409);
    }
    throw e;
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
      amountMinor: Math.round(deal.feeAmount * 100),
      currency: quote.currency,
      description: `${site.name} success fee — deal ${deal.id}`,
      idempotencyKey: deal.id,
      metadata: { dealId: deal.id, quoteId: quote.id },
    });
    // pending→invoiced, idempotent on retry (a repeat accept re-invoices
    // and refreshes the ref) but never resurrects paid/void (QA-145).
    const flipped = await repo.setDealInvoice(
      deal.id,
      "invoiced",
      invoice.id,
      ["pending", "invoiced"],
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
  return ok({ quote: await repo.getQuote(id), deal });
}
