import { z } from "zod";
import { site } from "@jetmarket/config";
import { clientIp, err, isUniqueViolation, ok, parseBody, rateLimit } from "@/lib/api";
import { successFeePctFor } from "@/lib/fees";
import { logWarn } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { emailProvider, paymentsProvider, analyticsProvider } from "@jetmarket/providers";

const Body = z.object({
  buyerEmail: z.string().email(),
  // Per-RFQ bearer token from the buyer's email link (QA-39).
  token: z.string().min(1),
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
  const rfq = await repo.getRfq(quote.rfqId);
  if (
    !rfq ||
    rfq.buyerEmail !== data!.buyerEmail ||
    rfq.accessToken !== data!.token
  ) {
    return err("not your quote", 403);
  }
  // The RFQ must still be live — a "sent" quote can outlive its RFQ when the
  // expiry sweep has not ticked yet (or isn't running in this environment).
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
      await repo.setQuoteStatus(q.id, "declined", "sent");
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
    await repo.setDealInvoice(deal.id, "invoiced", invoice.id);
    deal.invoiceStatus = "invoiced";
    deal.invoiceRef = invoice.id;
  } catch (e) {
    logWarn("invoice.create_failed", {
      dealId: deal.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const operator = await repo.getOperator(quote.operatorId);
  const owner = operator ? await repo.getUser(operator.userId) : undefined;
  if (owner) {
    await emailProvider().send({
      to: owner.email,
      subject: `Deal closed on “${listing?.title ?? "listing"}”`,
      text: `Buyer accepted your quote of ${quote.currency} ${quote.amount}. Success fee (${(feePct * 100).toFixed(1)}%): ${quote.currency} ${deal.feeAmount}. Invoice ${deal.invoiceRef ? `ref ${deal.invoiceRef}` : "pending"}.`,
    });
  }
  return ok({ quote: await repo.getQuote(id), deal });
}
