import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

const RateBody = z.object({ rating: z.number().int().min(1).max(5) });

/**
 * POST — the operator's once-ever 1-5 rating of the buyer on a closed deal
 * (QA-528). Mirror of the buyer's rate route: the aggregate lands on the
 * buyer's email and shows up as "rated buyer" on their next request in ANY
 * operator's inbox. Owner-scoped via deal→quote→operatorId — a foreign
 * deal is 404, same probe-proofing as the RFQ notes route. Deliberately
 * silent: no mail — a low rating isn't something the buyer gets notified
 * about (unlike the buyer→operator rating, which feeds their public ★).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`op-rate-deal:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, RateBody);
  if (error) return error;
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  const deal = await repo.getDeal(id);
  if (!deal || deal.operatorId !== operator.id) return err("not found", 404);
  // QA-551: a voided deal fell through — nothing real to score.
  if (deal.invoiceStatus === "void") {
    return err("deal was voided — nothing to rate", 409);
  }
  const rated = await repo.rateDealByOperator(id, data!.rating);
  if (!rated) return err("already rated", 409);
  return ok({ rated: true });
}
