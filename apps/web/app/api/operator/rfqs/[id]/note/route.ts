import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

const RfqNote = z.object({
  note: z.string().max(500),
});

/**
 * POST — set or clear the caller's private note on a visible RFQ (QA-524).
 * Same visibility gate as dismiss/report — only listing owners / delivered
 * matches may note, so the endpoint can't be probed for "does RFQ <id>
 * exist / am I matched to it". An empty note deletes the row; the note is
 * per-operator — no buyer or admin surface reads it.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`rfq-note:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, RfqNote);
  if (error) return error;
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  // Foreign-vertical rows 404 before the write (shared-DB rule).
  const rfq = await repo.getRfq(id);
  if (!rfq || rfq.vertical !== verticalSlug()) {
    return err("not found", 404);
  }
  // Visibility proof — same predicate the inbox uses: the operator owns
  // the listing or holds a delivered match for this RFQ.
  const visible = await repo.listRfqs({
    operatorId: operator.id,
    ids: [id],
  });
  if (visible.length === 0) return err("not found", 404);
  const stored = await repo.setRfqNote(operator.id, id, data!.note);
  logInfo("operator.rfq_note_set", {
    operatorId: operator.id,
    rfqId: id,
    hasNote: stored !== null,
  });
  return ok({ rfqId: id, note: stored?.note ?? null });
}
