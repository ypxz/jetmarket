import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";
import { z } from "zod";

/**
 * POST — dismiss many RFQs from the caller's operator inbox at once (QA-438).
 * Same guarantees as the single-row route, applied per id: the row must be
 * in-vertical and provably visible to this operator (repo.dismissRfq proves
 * list ownership or a delivered match), anything else is skipped silently —
 * a bulk request can't be probed for "does RFQ <id> exist" either, it just
 * gets a lower count back. Idempotent: re-sent ids simply don't count.
 */
const BulkDismiss = z.object({
  ids: z.array(z.string().uuid()).max(200),
});

export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`rfq-dismiss-bulk:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, BulkDismiss);
  if (error) return error;
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  const v = verticalSlug();
  let dismissed = 0;
  for (const id of data!.ids) {
    const rfq = await repo.getRfq(id);
    if (!rfq || rfq.vertical !== v) continue;
    if (await repo.dismissRfq(id, operator.id)) dismissed += 1;
  }
  return ok({ ok: true, dismissed });
}
