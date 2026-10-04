import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

const FlagRfq = z.object({
  reason: z.enum(["spam", "abusive", "duplicate", "other"]),
  note: z.string().max(500).optional(),
});

/**
 * POST — flag an RFQ from the caller's operator inbox (QA-469). The
 * demand-side twin of the buyer listing flag: the operator who actually
 * reads an abusive request can push it into admin moderation. Same
 * visibility gate as dismiss — only listing owners / delivered matches
 * may flag, so the endpoint can't be probed for "does RFQ <id> exist /
 * am I matched to it". One flag per (rfq, operator): a repeat 409s.
 * The flag's lifecycle is the RFQ's — spam-marking kills the target.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`rfq-report:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, FlagRfq);
  if (error) return error;
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  // Foreign-vertical rows 404 before the write (shared-DB rule).
  const rfq = await repo.getRfq(id);
  if (!rfq || rfq.vertical !== verticalSlug()) {
    return err("not found", 404);
  }
  // Visibility proof — same predicate the inbox/dismiss routes use: the
  // operator owns the listing or holds a delivered match for this RFQ.
  const visible = await repo.listRfqs({
    operatorId: operator.id,
    ids: [id],
  });
  if (visible.length === 0) return err("not found", 404);
  const report = await repo.createRfqReport({
    rfqId: id,
    reporterId: user.id,
    reason: data!.reason,
    note: data!.note,
  });
  if (!report) return err("already reported", 409);
  logInfo("operator.rfq_reported", {
    operatorId: operator.id,
    rfqId: id,
    reason: data!.reason,
  });
  return ok(report, 201);
}
