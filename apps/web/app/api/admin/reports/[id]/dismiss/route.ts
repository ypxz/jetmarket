import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { auditAdmin } from "@/lib/audit";
import { getRepo } from "@/lib/repo";

/**
 * Admin report dismiss (QA-461) — clears a flag from the review queue.
 * CAS on status='open': a repeat click 409s instead of rewriting. The
 * action is deliberately silent — no buyer/operator mail for a dismiss;
 * enforcement mails ride the moderation/suspension routes instead.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-report-dismiss:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { id } = await params;
  const repo = await getRepo();
  if (!(await repo.resolveListingReport(id))) {
    return err("report not found or already resolved", 409);
  }
  logInfo("admin.listing_report_dismissed", { adminId: user.id, reportId: id });
  await auditAdmin(repo, {
    adminId: user.id,
    event: "listing_report_dismissed",
    targetType: "listing_report",
    targetId: id,
  });
  return ok({ id, status: "dismissed" });
}
