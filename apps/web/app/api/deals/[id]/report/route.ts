import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";
import { buyerAuthorized } from "@/lib/buyer-auth";
import { logInfo } from "@/lib/log";

const Body = z.object({
  buyerEmail: z.string().email().max(254),
  // Per-RFQ bearer token from the buyer's email link (QA-39).
  token: z.string().max(256).optional().default(""),
  reason: z.enum(["no_service", "scam", "abusive", "other"]),
  note: z.string().max(500).optional(),
});

/**
 * Buyer flags a closed deal (QA-555) — the last unreported marketplace
 * entity: listings, RFQs and quotes all feed moderation, and the deal is
 * where money already moved (the charter never flew / scam / abuse; the
 * admin revert tool QA-550 had no buyer-side way to raise it). Auth is the
 * same mailbox proof every buyer deal action uses (session or the emailed
 * bearer token) — only the requester whose deal it is can flag it.
 * Deliberately silent toward the operator: an accusation mails nobody;
 * enforcement rides the moderation tools that DO notify (QA-461).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!rateLimit(`deal-report:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, Body);
  if (error) return error;

  const repo = await getRepo();
  const deal = await repo.getDeal(id);
  if (!deal) return err("not found", 404);
  const quote = await repo.getQuote(deal.quoteId);
  const rfq = quote ? await repo.getRfq(quote.rfqId) : undefined;
  // Same 403 the accept/decline family returns on failed mailbox proof —
  // the route can't be probed for deal existence or RFQ ownership.
  if (
    !rfq ||
    rfq.vertical !== verticalSlug() ||
    !(await buyerAuthorized(rfq, data!))
  ) {
    return err("not your deal", 403);
  }
  // QA-463 analog: a blocked address can't weaponize the flag queue.
  if (await repo.isEmailBlocked(data!.buyerEmail)) {
    return err("account blocked", 403);
  }
  const report = await repo.createDealReport({
    dealId: id,
    reporterEmail: rfq.buyerEmail,
    reason: data!.reason,
    note: data!.note,
  });
  if (!report) return err("already reported", 409);
  logInfo("deal.reported", {
    dealId: id,
    rfqId: rfq.id,
    reason: report.reason,
  });
  return ok(report, 201);
}
