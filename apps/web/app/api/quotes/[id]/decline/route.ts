import { z } from "zod";
import { err, ok, parseBody } from "@/lib/api";
import { getRepo } from "@/lib/repo";
import { analyticsProvider } from "@jetmarket/providers";

const Body = z.object({ buyerEmail: z.string().email() });

// Buyer declines a quote. Mock-mode identity = email param, same as accept —
// declining marks only the quote; the rfq keeps its status (spec: a declined
// last quote does not reopen or close the request).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { data, error } = await parseBody(req, Body);
  if (error) return error;

  const repo = await getRepo();
  const quote = await repo.getQuote(id);
  if (!quote) return err("quote not found", 404);
  const rfq = await repo.getRfq(quote.rfqId);
  if (!rfq || rfq.buyerEmail !== data!.buyerEmail) {
    return err("not your quote", 403);
  }
  if (quote.status !== "sent") return err(`quote already ${quote.status}`, 409);

  await repo.setQuoteStatus(id, "declined");
  analyticsProvider().track({
    name: "quote_declined",
    props: { quoteId: quote.id, rfqId: rfq.id },
  });
  return ok(await repo.getQuote(id));
}
