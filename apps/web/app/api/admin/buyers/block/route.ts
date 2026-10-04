import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { auditAdmin } from "@/lib/audit";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

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
    await auditAdmin(repo, {
      adminId: user.id,
      event: "buyer_unblocked",
      targetType: "buyer_email",
      targetId: email,
    });
    return ok({ email, blocked: false });
  }
  const row = await repo.blockBuyerEmail(email, {
    reason: data!.reason,
    by: user.id,
  });
  // QA-464: the block kills future filings; this clears what the buyer
  // already delivered — every live RFQ from the address flips to spam
  // (stops matching + notifying, per QA-181).
  const spammed = await repo.spamBuyerRfqs(email, verticalSlug());
  // QA-465: if the blocked address is also a signed-in user, their open
  // listing flags leave the queue too — weaponized reports shouldn't keep
  // demanding admin attention after the account is dead.
  const reporter = await repo.findUserByEmail(email);
  const reportsCleared = reporter
    ? await repo.resolveListingReportsByReporter(reporter.id)
    : 0;
  logInfo("admin.buyer_blocked", {
    adminId: user.id,
    email,
    rfqsSpammed: spammed,
    reportsCleared,
  });
  await auditAdmin(repo, {
    adminId: user.id,
    event: "buyer_blocked",
    targetType: "buyer_email",
    targetId: email,
    meta: { rfqsSpammed: spammed, reportsCleared },
  });
  return ok({ ...row, rfqsSpammed: spammed, reportsCleared });
}
