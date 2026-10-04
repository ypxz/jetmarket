import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

/**
 * DELETE — remove one of the caller's quote templates (QA-527). Scoped by
 * (operatorId, id) so the endpoint can't probe other operators' rows.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`quote-template-del:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  const deleted = await repo.deleteQuoteTemplate(operator.id, id);
  if (!deleted) return err("not found", 404);
  return ok({ deleted: true });
}
