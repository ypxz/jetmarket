import { z } from "zod";
import { analyticsProvider } from "@jetmarket/providers";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { logInfo } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { rfqDeadlineAt } from "@/lib/rfq-deadline";
import { verticalSlug } from "@/lib/vertical";
import { buyerAuthorized } from "@/lib/buyer-auth";

const ReopenRfq = z.object({
  buyerEmail: z.string().email().max(254),
  token: z.string().max(256).optional().default(""),
});

/** Buyer reopen (QA-540): QA-182's close is one-way — a buyer who closed
 *  by accident, or changed their mind, could only repost (fresh RFQ,
 *  abandoned history). `closed → open` under the same CAS pattern brings
 *  the row back to live states: prior quotes STAY declined (ops re-offer
 *  via the QA-510 re-quote path; the delivered matches simply re-enter
 *  live inboxes — no fan-out replay, no mail).
 *
 *  Guards: only the buyer's own token/session auth; the liveness horizon
 *  must still be in the future (QA-442 rule) — reopening a row whose
 *  deadline already passed would just re-expire on the next sweep, so it
 *  409s with a "post a fresh request" hint instead. Spam stays terminal:
 *  'spam' is deliberately NOT in the expected set (moderation is
 *  admin-final). Paused-then-closed rows keep `pausedAt` — they reopen
 *  frozen, which the buyer can resume separately. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!rateLimit(`rfq-reopen:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, ReopenRfq);
  if (error) return error;
  const { id } = await params;
  const repo = await getRepo();
  const rfq = await repo.getRfq(id);
  if (
    !rfq ||
    rfq.vertical !== verticalSlug() ||
    !(await buyerAuthorized(rfq, data!))
  ) {
    return err("not found", 404);
  }
  // An expired row (memory impls stamp it; drizzle folds it into
  // 'closed') can never come back — it re-expires on the next sweep.
  if (rfq.status === "expired") {
    return err("deadline already passed — post a fresh request", 409);
  }
  if (rfq.status !== "closed") {
    return err("rfq is not closed", 409);
  }
  // Same verdict for a closed row whose horizon already lapsed — the
  // sweep just hasn't flipped it to expired yet.
  if (rfqDeadlineAt(rfq) <= new Date()) {
    return err("deadline already passed — post a fresh request", 409);
  }
  if (!(await repo.setRfqStatus(id, "open", ["closed"]))) {
    return err("rfq is not closed", 409);
  }
  logInfo("rfq.reopened", { rfqId: id });
  analyticsProvider().track({
    name: "rfq_reopened",
    props: { rfqId: id },
  });
  return ok({ id, status: "open" });
}
