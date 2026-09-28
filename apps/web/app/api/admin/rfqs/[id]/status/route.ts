import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { getRepo } from "@/lib/repo";

const ModerateRfq = z.object({
  // Spam is the only moderation action — the honeypot pretends success but
  // never persists, so real spam lands in the inbox until an admin bins it.
  // Terminal RFQs (closed/expired/spam) can't be re-spammed: the expectedIn
  // guard returns false and the row already does nothing.
  status: z.enum(["spam"]),
});

/** Admin RFQ moderation (QA-181): mark an abusive live RFQ as spam. A
 *  spammed RFQ stops matching (fan-out only runs on 'new') and stops
 *  notifying (deliverDueMatches + quote_notification gate on live
 *  parent status), so one click kills every downstream effect. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-rfq-mod:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { error } = await parseBody(req, ModerateRfq);
  if (error) return error;
  const { id } = await params;
  const repo = await getRepo();
  const rfq = await repo.getRfq(id);
  if (!rfq) return err("not found", 404);
  const flipped = await repo.setRfqStatus(id, "spam", [
    "open",
    "matched",
    "quoted",
  ]);
  if (!flipped) return err("already in a terminal state", 409);
  logInfo("admin.rfq_moderated", {
    adminId: user.id,
    rfqId: id,
    status: "spam",
  });
  return ok({ id, status: "spam" });
}
