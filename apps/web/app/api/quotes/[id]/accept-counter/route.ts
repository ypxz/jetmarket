import { analyticsProvider } from "@jetmarket/providers";
import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { closeDealForQuote } from "@/lib/deal";
import { getRepo } from "@/lib/repo";
import { isExpiredListing } from "@/lib/search";
import { verticalSlug } from "@/lib/vertical";
import { appOrigin } from "@/lib/origin";

/** Operator takes the buyer's counter (QA-515): the buyer put a number on
 *  the table and the operator says "done" — the deal mints at
 *  `counterAmount`, not the original ask. This is the close-out third of
 *  the negotiation: revise (counter-offer back), ignore, or take it.
 *  The deal machinery is shared with the buyer accept route
 *  (lib/deal.ts) — same CAS order, rollback, sibling declines, invoice,
 *  sold-flip; only the actor guard and the price differ. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`quote-accept-counter:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  // Suspended ops can't form deals — same gate as revise (QA-472).
  if (operator.suspended) return err("account suspended", 403);

  const { id } = await params;
  const quote = await repo.getQuote(id);
  if (!quote) return err("quote not found", 404);
  if (quote.operatorId !== operator.id) return err("not your quote", 403);
  if (quote.status !== "sent") return err(`quote already ${quote.status}`, 409);
  const rfq = await repo.getRfq(quote.rfqId);
  if (!rfq || rfq.vertical !== verticalSlug()) {
    return err("quote not found", 404);
  }
  // There must actually BE a live counter — nothing to take otherwise.
  if (quote.counteredAt === undefined || quote.counterAmount === undefined) {
    return err("no counter on the table", 409);
  }
  if (!["open", "matched", "quoted"].includes(rfq.status)) {
    return err("rfq is no longer open", 409);
  }
  // Same market guards as the buyer accept: a dead listing can't close.
  const parentListing = rfq.listingId
    ? await repo.getListing(rfq.listingId)
    : undefined;
  if (
    parentListing?.status === "archived" ||
    parentListing?.status === "sold"
  ) {
    return err("listing is no longer available", 409);
  }
  if (
    parentListing &&
    quote.operatorId === parentListing.operatorId &&
    isExpiredListing(parentListing)
  ) {
    return err("listing is no longer available", 409);
  }

  // Taking the counter = revising TO their number then closing. The
  // revise stamps the quote's final price at counterAmount (deals derive
  // their amount from the quote row) and clears the counter — what the
  // buyer sees next is the price they proposed, now signed.
  const met = await repo.reviseQuote(id, operator.id, {
    amount: quote.counterAmount,
    currency: quote.currency,
    message: "",
  // QA-522: taking their number IS the close — the round ends 'accepted'
  // on the audit trail, not merely 'answered'.
  }, { counterOutcome: "accepted" });
  if (!met) return err("quote already transitioned", 409);
  const closed = await closeDealForQuote({
    repo,
    quote: met,
    rfq,
    listing: parentListing,
    amount: met.amount,
    origin: appOrigin(req),
  });
  if (closed.error) return err(closed.error.msg, closed.error.status);

  analyticsProvider().track({
    name: "counter_accepted",
    props: {
      quoteId: quote.id,
      rfqId: rfq.id,
      operatorId: operator.id,
      amount: quote.counterAmount,
    },
  });
  return ok({ quote: await repo.getQuote(id), deal: closed.deal });
}
