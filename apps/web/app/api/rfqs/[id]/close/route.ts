import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { logInfo } from "@/lib/log";
import { notifyQuoteDeclined } from "@/lib/notify";
import { getRepo } from "@/lib/repo";

const CloseRfq = z.object({
  buyerEmail: z.string().email().max(254),
  token: z.string().min(1).max(256),
});

/** Buyer-initiated close (QA-182): the bearer-token holder withdraws their
 *  own request. Same CAS as quote accept — flipping the RFQ out of live
 *  states makes every pending accept fail arbitration (QA-99), then the
 *  still-'sent' quotes get declined with an operator notification, mirroring
 *  the expiry sweep's cascade. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!rateLimit(`rfq-close:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, CloseRfq);
  if (error) return error;
  const { id } = await params;
  const repo = await getRepo();
  const rfq = await repo.getRfq(id);
  if (
    !rfq ||
    rfq.buyerEmail.toLowerCase() !== data!.buyerEmail.toLowerCase() ||
    rfq.accessToken !== data!.token
  ) {
    return err("not found", 404);
  }
  // CAS: closed wins over every pending accept — they fail their own RFQ
  // flip (the QA-99 single-winner arbiter) and never mint a deal.
  if (
    !(await repo.setRfqStatus(id, "closed", ["open", "matched", "quoted"]))
  ) {
    return err("rfq is no longer open", 409);
  }
  let declined = 0;
  for (const q of await repo.listQuotes({ rfqId: rfq.id })) {
    if (q.status === "sent" && (await repo.setQuoteStatus(q.id, "declined", "sent"))) {
      declined++;
      await notifyQuoteDeclined(repo, q, rfq, "rfq-closed");
    }
  }
  logInfo("rfq.closed_by_buyer", { rfqId: rfq.id, declined });
  return ok({ id: rfq.id, status: "closed", declined });
}
