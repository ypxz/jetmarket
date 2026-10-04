import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

/**
 * Admin clears an abusive buyer rating (QA-458) — the once-ever write was
 *  a trust tool with no recourse; this restores the row to unrated so the
 *  buyer can re-rate through the normal CAS. No notify: the rating just
 *  disappears — a mail would market the moderation itself.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-deal-clear-rating:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { id } = await params;
  const repo = await getRepo();
  const deal = await repo.getDeal(id);
  if (!deal) return err("deal not found", 404);
  // Per-vertical boundary via quote → rfq (QA-296).
  const quote = await repo.getQuote(deal.quoteId);
  const rfq = quote ? await repo.getRfq(quote.rfqId) : undefined;
  if (rfq && rfq.vertical !== verticalSlug())
    return err("deal not found", 404);
  if (!(await repo.clearDealRating(id))) {
    return err("deal has no rating to clear", 409);
  }
  logInfo("admin.deal_rating_cleared", { adminId: user.id, dealId: id });
  return ok(await repo.getDeal(id));
}
