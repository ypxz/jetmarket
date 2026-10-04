import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { auditAdmin } from "@/lib/audit";
import { notifyBuyerRfqClosed, notifyQuoteDeclined } from "@/lib/notify";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

const ModerateRfq = z.object({
  // 'spam' bins abusive/junk demand — the honeypot pretends success but
  // never persists, so real spam lands in the inbox until an admin bins it.
  // 'closed' (QA-525) force-closes a live-but-legit RFQ the buyer won't
  // close themselves — same CAS + sent-quote decline cascade as the
  // buyer-initiated close, plus a buyer-facing mail (spam stays silent).
  // Terminal RFQs (closed/expired/spam) can't be re-moderated: the
  // expectedIn guard returns false and the row already does nothing.
  status: z.enum(["spam", "closed"]),
});

const LIVE_RFQ = ["open", "matched", "quoted"] as const;

/** Admin RFQ moderation (QA-181): mark an abusive live RFQ as spam, or
 *  (QA-525) force-close a live one. A spammed RFQ stops matching (fan-out
 *  only runs on 'new') and stops notifying (deliverDueMatches +
 *  quote_notification gate on live parent status), so one click kills
 *  every downstream effect. Force-close mirrors the buyer close: flipping
 *  the RFQ out of live states makes pending accepts fail arbitration
 *  (QA-99), then still-'sent' quotes decline with an operator
 *  notification — and the buyer is mailed that their request was closed. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-rfq-mod:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, ModerateRfq);
  if (error) return error;
  const { id } = await params;
  const repo = await getRepo();
  const rfq = await repo.getRfq(id);
  // Per-vertical admin boundary (QA-296): a shared DB hosts every vertical's
  // rows — this deploy's admin must not moderate another vertical's RFQs.
  if (!rfq || rfq.vertical !== verticalSlug()) return err("not found", 404);
  const flipped = await repo.setRfqStatus(id, data!.status, [...LIVE_RFQ]);
  if (!flipped) return err("already in a terminal state", 409);

  let declined = 0;
  if (data!.status === "closed") {
    for (const q of await repo.listQuotes({ rfqId: rfq.id })) {
      if (
        q.status === "sent" &&
        (await repo.setQuoteStatus(q.id, "declined", "sent"))
      ) {
        declined++;
        await notifyQuoteDeclined(repo, q, rfq, "rfq-closed");
      }
    }
    await notifyBuyerRfqClosed(repo, rfq);
  }

  logInfo("admin.rfq_moderated", {
    adminId: user.id,
    rfqId: id,
    status: data!.status,
    declined,
  });
  await auditAdmin(repo, {
    adminId: user.id,
    event: "rfq_moderated",
    targetType: "rfq",
    targetId: id,
    meta: { status: data!.status, declined },
  });
  return ok({ id, status: data!.status, declined });
}
