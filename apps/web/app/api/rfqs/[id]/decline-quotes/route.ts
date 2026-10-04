import { z } from "zod";
import { analyticsProvider } from "@jetmarket/providers";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { logInfo } from "@/lib/log";
import { notifyQuoteDeclined } from "@/lib/notify";
import { getRepo } from "@/lib/repo";
import { QUOTE_DECLINE_REASONS } from "@/lib/repo/types";
import { verticalSlug } from "@/lib/vertical";
import { buyerAuthorized } from "@/lib/buyer-auth";

const DeclineQuotes = z.object({
  buyerEmail: z.string().email().max(254),
  token: z.string().max(256).optional().default(""),
  reason: z.enum(QUOTE_DECLINE_REASONS).optional(),
});

/** Buyer-initiated bulk decline (QA-534): "none of these work — keep the
 *  request open". Distinct from close (QA-182): the RFQ stays live and
 *  keeps collecting offers — only the CURRENT sent quotes die. Each quote
 *  flips under the same 'sent'-guard CAS as the single-decline route, so
 *  an accept racing the sweep still wins arbitration (QA-99); its sibling
 *  declines then just no-op. Every declined operator gets the standard
 *  mail, with the buyer's shared reason when one was picked. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!rateLimit(`rfq-decline-quotes:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, DeclineQuotes);
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
  const live = (await repo.listQuotes({ rfqId: rfq.id })).filter(
    (q) => q.status === "sent",
  );
  if (live.length === 0) {
    return err("no live offers to decline", 409);
  }
  let declined = 0;
  for (const q of live) {
    if (
      await repo.setQuoteStatus(q.id, "declined", "sent", {
        declineReason: data!.reason,
      })
    ) {
      declined++;
      // Non-fatal — same rule as every notify site.
      await notifyQuoteDeclined(repo, q, rfq, "declined", data!.reason);
    }
  }
  logInfo("rfq.quotes_declined", { rfqId: rfq.id, declined });
  analyticsProvider().track({
    name: "rfq_quotes_declined",
    props: {
      rfqId: rfq.id,
      declined,
      ...(data!.reason ? { reason: data!.reason } : {}),
    },
  });
  return ok({ id: rfq.id, declined });
}
