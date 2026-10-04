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
  reason: z.enum(["off_platform", "scam", "spam", "abusive", "other"]),
  note: z.string().max(500).optional(),
});

/**
 * Buyer flags a received quote (QA-529) — the last unreported surface: an
 * "call me at +41..." in the message field is THE fee-circumvention
 * vector, and there was no way to push it into admin moderation. Auth is
 * the same mailbox proof every buyer quote action uses (session or the
 * emailed bearer token) — only the requester who received the quote can
 * flag it. Deliberately silent toward the operator: an accusation mails
 * nobody; enforcement rides the moderation tools that DO notify (QA-461).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!rateLimit(`quote-report:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, Body);
  if (error) return error;

  const repo = await getRepo();
  const quote = await repo.getQuote(id);
  if (!quote) return err("not found", 404);
  const rfq = await repo.getRfq(quote.rfqId);
  // Same 403 the accept/decline family returns on failed mailbox proof —
  // the route can't be probed for quote existence or RFQ ownership.
  if (
    !rfq ||
    rfq.vertical !== verticalSlug() ||
    !(await buyerAuthorized(rfq, data!))
  ) {
    return err("not your quote", 403);
  }
  // QA-463 analog: a blocked address can't weaponize the flag queue.
  if (await repo.isEmailBlocked(data!.buyerEmail)) {
    return err("account blocked", 403);
  }
  const report = await repo.createQuoteReport({
    quoteId: id,
    reporterEmail: rfq.buyerEmail,
    reason: data!.reason,
    note: data!.note,
  });
  if (!report) return err("already reported", 409);
  logInfo("quote.reported", {
    quoteId: id,
    rfqId: rfq.id,
    reason: report.reason,
  });
  return ok(report, 201);
}
