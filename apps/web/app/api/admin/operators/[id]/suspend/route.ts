import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { auditAdmin } from "@/lib/audit";
import { analyticsProvider } from "@jetmarket/providers";
import { notifyOperatorSuspended } from "@/lib/notify";
import { getRepo } from "@/lib/repo";

/**
 * Admin suspension toggle (QA-460) — stronger than verified=false: hides
 * the operator's supply from public browse, stops fan-outs, and blocks
 * their listing/quote writes. Operators are global (not per-vertical) so
 * no vertical scoping applies — same as verify.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-op-suspend:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { id } = await params;
  const repo = await getRepo();
  const op = await repo.getOperator(id);
  if (!op) return err("not found", 404);
  await repo.setOperatorSuspended(id, !op.suspended);
  analyticsProvider().track({
    name: "operator_suspension_toggled",
    props: { operatorId: id, suspended: !op.suspended },
  });
  // Enforcement must reach the owner (QA-249 convention). Non-fatal.
  await notifyOperatorSuspended(repo, id, !op.suspended);
  logInfo("admin.operator_suspension_toggled", {
    adminId: user.id,
    operatorId: id,
    suspended: !op.suspended,
  });
  await auditAdmin(repo, {
    adminId: user.id,
    event: "operator_suspension_toggled",
    targetType: "operator",
    targetId: id,
    meta: { suspended: !op.suspended },
  });
  return ok(await repo.getOperator(id));
}
