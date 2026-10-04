import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { auditAdmin } from "@/lib/audit";
import { notifyOperatorVerified } from "@/lib/notify";
import { getRepo } from "@/lib/repo";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-op-verify:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { id } = await params;
  const repo = await getRepo();
  const op = await repo.getOperator(id);
  if (!op) return err("not found", 404);
  await repo.setOperatorVerified(id, !op.verified);
  // Trust-signal change must reach the owner (QA-249). Non-fatal.
  await notifyOperatorVerified(repo, id, !op.verified);
  logInfo("admin.operator_verify_toggled", {
    adminId: user.id,
    operatorId: id,
    verified: !op.verified,
  });
  await auditAdmin(repo, {
    adminId: user.id,
    event: "operator_verify_toggled",
    targetType: "operator",
    targetId: id,
    meta: { verified: !op.verified },
  });
  return ok(await repo.getOperator(id));
}
