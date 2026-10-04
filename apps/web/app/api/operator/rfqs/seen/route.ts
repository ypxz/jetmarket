import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

/**
 * POST — stamp the caller's operator inbox_seen_at (QA-416). The inbox
 * badges RFQs created after the last stamp; once a render happens the page
 * posts here so a reload only badges genuinely newer arrivals.
 */
export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`rfq-seen:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  await repo.markInboxSeen(operator.id);
  return ok({ ok: true });
}
