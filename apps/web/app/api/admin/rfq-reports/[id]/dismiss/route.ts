import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { auditAdmin } from "@/lib/audit";
import { getRepo } from "@/lib/repo";

/**
 * Admin RFQ-report dismiss (QA-539) — clears an operator flag from the
 * review queue when the accusation doesn't hold. CAS on status='open':
 * a repeat click 409s. Deliberately silent — no mail for a dismiss;
 * enforcement mails ride the moderation routes instead (QA-461 rule).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-rfq-report-dismiss:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { id } = await params;
  const repo = await getRepo();
  if (!(await repo.resolveRfqReport(id))) {
    return err("report not found or already resolved", 409);
  }
  logInfo("admin.rfq_report_dismissed", { adminId: user.id, reportId: id });
  await auditAdmin(repo, {
    adminId: user.id,
    event: "rfq_report_dismissed",
    targetType: "rfq_report",
    targetId: id,
  });
  return ok({ id, status: "dismissed" });
}
