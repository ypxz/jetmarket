import { z } from "zod";
import { err, ok, parseBody } from "@/lib/api";
import { getRepo } from "@/lib/repo";

// TODO(T27): W2 owns the full lifecycle semantics (rfq expiry sweep etc.) —
// this is the minimal decline route the buyer UI posts to.
const Body = z.object({ buyerEmail: z.string().email() });

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
  return ok({ quote: await repo.getQuote(id) });
}
