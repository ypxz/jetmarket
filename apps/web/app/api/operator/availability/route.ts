import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

const AvailabilityBody = z.object({ accepting: z.boolean() });

/**
 * POST { accepting: boolean } — operator away switch (QA-427). False removes
 * the operator from every NEW RFQ fan-out (web inline + worker candidates);
 * already-delivered matches stay in the inbox and existing quotes live on.
 */
export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`op-availability:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, AvailabilityBody);
  if (error) return error;
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  // QA-460: a suspended operator can't flip their own away switch back.
  if (operator.suspended) return err("account suspended", 403);
  await repo.setOperatorAccepting(operator.id, data!.accepting);
  return ok({ ok: true, accepting: data!.accepting });
}
