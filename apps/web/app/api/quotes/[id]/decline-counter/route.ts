import { analyticsProvider } from "@jetmarket/providers";
import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { notifyCounterDeclined } from "@/lib/notify";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

/** Operator declines the buyer's counter (QA-519): the third answer to
 *  "you countered" — take it (accept-counter), answer it (revise), or
 *  say no. A lowball shouldn't leave the buyer waiting in silence; the
 *  counter clears off the row (same CAS as withdraw/revise) and the
 *  buyer gets mail saying the ask still stands — they can re-counter,
 *  accept, or walk. Declining doesn't spend the round. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`quote-decline-counter:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);

  const { id } = await params;
  const quote = await repo.getQuote(id);
  if (!quote) return err("quote not found", 404);
  if (quote.operatorId !== operator.id) return err("not your quote", 403);
  if (quote.status !== "sent") return err(`quote already ${quote.status}`, 409);
  const rfq = await repo.getRfq(quote.rfqId);
  if (!rfq || rfq.vertical !== verticalSlug()) {
    return err("quote not found", 404);
  }
  // Same live-window as the QA-516 nudge sweep: declining into a dead
  // request would mail the buyer "the ask stands" over a request that
  // doesn't.
  if (!["new", "matched", "quoted"].includes(rfq.status)) {
    return err("rfq is no longer open", 409);
  }
  // Must be a live counter to decline — the 'sent' + countered CAS is
  // also what the repo method checks; grab the number for the mail first.
  const declined = quote.counterAmount;
  if (declined === undefined || !(await repo.clearQuoteCounter(id, "declined"))) {
    return err("no counter on the table", 409);
  }
  analyticsProvider().track({
    name: "counter_declined",
    props: {
      quoteId: quote.id,
      rfqId: rfq.id,
      counterAmount: declined,
      ask: quote.amount,
    },
  });
  await notifyCounterDeclined(repo, quote, rfq, declined);
  return ok(await repo.getQuote(id));
}
