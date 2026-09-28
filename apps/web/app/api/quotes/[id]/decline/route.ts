import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { getRepo } from "@/lib/repo";
import { notifyQuoteDeclined } from "@/lib/notify";
import { analyticsProvider } from "@jetmarket/providers";
import { verticalSlug } from "@/lib/vertical";

const Body = z.object({
  buyerEmail: z.string().email().max(254),
  token: z.string().min(1).max(256),
});

// Buyer declines a quote. Gated on the per-RFQ bearer token (QA-39) —
// declining marks only the quote; the rfq keeps its status (spec: a declined
// last quote does not reopen or close the request).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!rateLimit(`quote-decline:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, Body);
  if (error) return error;

  const repo = await getRepo();
  const quote = await repo.getQuote(id);
  if (!quote) return err("quote not found", 404);
  const rfq = await repo.getRfq(quote.rfqId);
  // Case-insensitive buyer email match — see accept (QA-153). Vertical
  // guard as on accept (QA-298).
  if (
    !rfq ||
    rfq.vertical !== verticalSlug() ||
    rfq.buyerEmail.toLowerCase() !== data!.buyerEmail.toLowerCase() ||
    rfq.accessToken !== data!.token
  ) {
    return err("not your quote", 403);
  }
  if (quote.status !== "sent") return err(`quote already ${quote.status}`, 409);

  if (!(await repo.setQuoteStatus(id, "declined", "sent"))) {
    return err("quote already transitioned", 409);
  }
  analyticsProvider().track({
    name: "quote_declined",
    props: { quoteId: quote.id, rfqId: rfq.id },
  });
  await notifyQuoteDeclined(repo, quote, rfq, "declined");
  return ok(await repo.getQuote(id));
}
