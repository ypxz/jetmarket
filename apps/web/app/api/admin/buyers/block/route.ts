import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { getRepo } from "@/lib/repo";

/**
 * Buyer email block toggle (QA-463) — the account-level counterpart of the
 * per-RFQ spam mark: a serial abuser's address is refused at RFQ-create and
 * report filing. Deliberately silent toward the blocked party — confirming
 * the block to a spammer only tells them the address works (unlike the
 * operator suspension, where the counterparty is a real partner).
 */
const Block = z.object({
  email: z.string().email().max(320),
  reason: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-buyer-block:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, Block);
  if (error) return error;
  const email = data!.email.toLowerCase();
  const repo = await getRepo();
  if (await repo.isEmailBlocked(email)) {
    await repo.unblockBuyerEmail(email);
    logInfo("admin.buyer_unblocked", { adminId: user.id, email });
    return ok({ email, blocked: false });
  }
  const row = await repo.blockBuyerEmail(email, {
    reason: data!.reason,
    by: user.id,
  });
  logInfo("admin.buyer_blocked", { adminId: user.id, email });
  return ok(row);
}
