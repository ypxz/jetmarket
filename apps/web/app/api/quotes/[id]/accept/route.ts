import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { getRepo } from "@/lib/repo";
import { sweepStaleRfqs } from "@/lib/sweep";
import { closeDealForQuote } from "@/lib/deal";
import { isExpiredListing } from "@/lib/search";
import { verticalSlug } from "@/lib/vertical";
import { buyerAuthorized } from "@/lib/buyer-auth";
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
  // QA-502: an expired one-off listing is gone from the market too — its
  // dates already passed, so the LISTING OWNER's own quote can never be
  // honored. Fan-out quotes on the same RFQ are unaffected: another
  // operator can still serve the request on their own aircraft.
  if (
    parentListing &&
    quote.operatorId === parentListing.operatorId &&
    isExpiredListing(parentListing)
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

  // QA-515: the arbitration + deal machinery moved to lib/deal.ts, shared
  // with the operator's accept-the-counter route — agreed price is the
  // quoted amount here.
  const closed = await closeDealForQuote({
    repo,
    quote,
    rfq,
    listing: parentListing,
    amount: quote.amount,
    origin: appOrigin(req),
  });
  if (closed.error) return err(closed.error.msg, closed.error.status);

  return ok({ quote: await repo.getQuote(id), deal: closed.deal });
}
