import { analyticsProvider } from "@jetmarket/providers";
import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { getRepo } from "@/lib/repo";
import { notifyDealRated } from "@/lib/notify";
import { verticalSlug } from "@/lib/vertical";
import { buyerAuthorized } from "@/lib/buyer-auth";

const Body = z.object({
  buyerEmail: z.string().email(),
  token: z.string().max(256).optional().default(""),
  rating: z.number().int().min(1).max(5),
});

/**
 * Buyer rates a closed deal 1-5 (QA-451) — same bearer-token auth the
 * close/extend routes use (email+token+vertical trio, then the once-ever
 * repo CAS). The trust signal lands on the operator's next quote cards.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!rateLimit(`deal-rate:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, Body);
  if (error) return error;

  const repo = await getRepo();
  const { id } = await params;
  const deal = await repo.getDeal(id);
  const quote = deal ? await repo.getQuote(deal.quoteId) : undefined;
  const rfq = quote ? await repo.getRfq(quote.rfqId) : undefined;
  // Same uniform 404 as close/extend — a wrong buyer can't tell the deal
  // exists from the response (QA trio).
  if (
    !rfq ||
    rfq.vertical !== verticalSlug() ||
    !(await buyerAuthorized(rfq, data!))
  ) {
    return err("not found", 404);
  }

  const rated = await repo.rateDeal(id, data!.rating);
  if (!rated) return err("already rated", 409);
  // The rating just rewrote the operator's public ★ record — the notify
  // rule says they hear about it (non-fatal inside the helper). deal is
  // non-null here — the auth trio only passes when deal→quote→rfq resolved.
  await notifyDealRated(repo, deal!, data!.rating);
  analyticsProvider().track({
    name: "deal_rated",
    props: { dealId: id, rating: data!.rating },
  });
  return ok({ rated: true, rating: data!.rating });
}
