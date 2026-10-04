import { z } from "zod";
import { analyticsProvider } from "@jetmarket/providers";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { notifyBuyerQuoteRevised } from "@/lib/notify";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

const ReviseQuote = z.object({
  amount: z.number().positive().max(1e9),
  currency: z.string().length(3),
  message: z.string().max(2000).default(""),
});

/** Operator revises their own still-'sent' quote (QA-439): fat-fingered
 *  prices and stalled offers need an edit path that isn't withdraw+lose.
 *  The CAS gates everything — a buyer accept or RFQ close racing the write
 *  makes it a no-op (null → 409), so terms can never change under a signed
 *  deal. Buyer is emailed the new amount; failures never fail the request. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`quote-revise:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, ReviseQuote);
  if (error) return error;
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  // QA-472: revising is a market-facing write — same suspension gate as
  // quote creation. (Withdraw stays open: retreat is cleanup, not trade.)
  if (operator.suspended) return err("account suspended", 403);

  const { id } = await params;
  const quote = await repo.getQuote(id);
  if (!quote) return err("quote not found", 404);
  if (quote.operatorId !== operator.id) return err("not your quote", 403);
  if (quote.status !== "sent") return err(`quote already ${quote.status}`, 409);
  const rfq = await repo.getRfq(quote.rfqId);
  if (rfq && rfq.vertical !== verticalSlug()) {
    return err("quote not found", 404);
  }

  const revised = await repo.reviseQuote(id, operator.id, {
    amount: data!.amount,
    currency: data!.currency,
    message: data!.message ?? "",
  });
  if (!revised) return err("quote already transitioned", 409);
  if (rfq) await notifyBuyerQuoteRevised(repo, revised, rfq);
  analyticsProvider().track({
    name: "quote_revised",
    props: { quoteId: id, rfqId: quote.rfqId, operatorId: operator.id },
  });
  return ok(revised);
}
