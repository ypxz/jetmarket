import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

const NotifyPrefsBody = z.object({ rfqMatch: z.boolean() });

/**
 * POST { rfqMatch: boolean } — match-mail mute switch (QA-505). False keeps
 * fan-out matches landing in the inbox but stops the "new/amended RFQ"
 * emails; true restores them. Distinct from the away switch: the operator
 * still receives and can quote every matched request.
 */
export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`op-notify-prefs:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, NotifyPrefsBody);
  if (error) return error;
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  await repo.setOperatorNotifyRfqMatch(operator.id, data!.rfqMatch);
  return ok({ ok: true, rfqMatch: data!.rfqMatch });
}
