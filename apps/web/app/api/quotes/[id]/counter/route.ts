import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { getRepo } from "@/lib/repo";
import { notifyQuoteCountered } from "@/lib/notify";
import { analyticsProvider } from "@jetmarket/providers";
import { verticalSlug } from "@/lib/vertical";
import { buyerAuthorized } from "@/lib/buyer-auth";

const Body = z.object({
  buyerEmail: z.string().email().max(254),
  token: z.string().max(256).optional().default(""),
  // QA-511: the buyer's proposed price, in display units of the quote's
  // own currency. Counters at or above the ask are pointless — the buyer
  // could just accept.
  amount: z.number().int().positive().max(999_999_999),
});

// Buyer counters a sent quote (QA-511). Gated on the per-RFQ bearer
// token like accept/decline. The quote stays 'sent' — the counter is a
// negotiation note the operator answers via revise/withdraw; one live
// counter per offer round (a revise clears it).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!rateLimit(`quote-counter:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, Body);
  if (error) return error;

  const repo = await getRepo();
  const quote = await repo.getQuote(id);
  if (!quote) return err("quote not found", 404);
  const rfq = await repo.getRfq(quote.rfqId);
  // Same buyer-auth + vertical guard as accept/decline (QA-153/298).
  if (
    !rfq ||
    rfq.vertical !== verticalSlug() ||
    !(await buyerAuthorized(rfq, data!))
  ) {
    return err("not your quote", 403);
  }
  if (quote.status !== "sent") return err(`quote already ${quote.status}`, 409);
  if (quote.counteredAt) return err("counter already on the table", 409);
  if (data!.amount >= quote.amount) {
    return err("a counter must be below the asking price", 422);
  }

  if (!(await repo.counterQuote(id, data!.amount))) {
    return err("quote already transitioned", 409);
  }
  analyticsProvider().track({
    name: "quote_countered",
    props: { quoteId: quote.id, rfqId: rfq.id, amount: data!.amount },
  });
  await notifyQuoteCountered(repo, quote, rfq, data!.amount);
  return ok(await repo.getQuote(id));
}
