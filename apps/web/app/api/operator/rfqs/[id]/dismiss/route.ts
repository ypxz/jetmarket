import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

/**
 * POST — dismiss an RFQ from the caller's operator inbox (QA-420). Per-
 * operator triage state: the RFQ stays visible to other operators and the
 * buyer; it only leaves THIS inbox (and its delayed-match teaser count).
 * repo.dismissRfq itself proves the RFQ is in the caller's inbox (owns the
 * listing or holds a delivered match) — anything else 404s so the endpoint
 * can't be probed for "does RFQ <id> exist / am I matched to it".
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`rfq-dismiss:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  // Foreign-vertical rows 404 before the write (shared-DB rule).
  const rfq = await repo.getRfq(id);
  if (!rfq || rfq.vertical !== verticalSlug()) {
    return err("not found", 404);
  }
  if (!(await repo.dismissRfq(id, operator.id))) {
    return err("not found", 404);
  }
  return ok({ ok: true });
}

/**
 * DELETE — undo a dismiss (QA-421): the RFQ re-enters the caller's inbox.
 * repo.undismissRfq deletes the pair itself — false when nothing was
 * dismissed, which also covers ids the operator could never see (a pair
 * can't exist without a prior dismissRfq's visibility proof).
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`rfq-undismiss:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  const rfq = await repo.getRfq(id);
  if (!rfq || rfq.vertical !== verticalSlug()) {
    return err("not found", 404);
  }
  if (!(await repo.undismissRfq(id, operator.id))) {
    return err("not found", 404);
  }
  return ok({ ok: true });
}
