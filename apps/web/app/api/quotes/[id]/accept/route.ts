import { z } from "zod";
import { err, ok, parseBody } from "@/lib/api";
import { successFeePctFor } from "@/lib/fees";
import { logWarn } from "@/lib/log";
import { sendMail } from "@/lib/outbox";
import { getRepo } from "@/lib/repo";
import { paymentsProvider } from "@jetmarket/providers";

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

  await repo.setQuoteStatus(id, "accepted");
  for (const q of await repo.listQuotes({ rfqId: rfq.id })) {
    if (q.id !== id && q.status === "sent") await repo.setQuoteStatus(q.id, "declined");
  }

  const listing = await repo.getListing(rfq.listingId);
  const feePct = listing ? successFeePctFor(listing.type) : 0.03;
  const deal = await repo.createDeal({
    quoteId: quote.id,
    operatorId: quote.operatorId,
    amount: quote.amount,
    feePct,
    feeAmount: Math.round(quote.amount * feePct * 100) / 100,
    invoiceStatus: "pending",
  });
  await repo.setRfqStatus(rfq.id, "closed");

  // Success-fee invoice via the payments adapter. A provider hiccup never
  // blocks the accept — the deal stays invoiceStatus "pending" for retry.
  try {
    const invoice = await paymentsProvider().createInvoice({
      customerId: quote.operatorId,
      amountMinor: Math.round(deal.feeAmount * 100),
      currency: quote.currency,
      description: `JetMarket success fee — deal ${deal.id}`,
      idempotencyKey: deal.id,
      metadata: { dealId: deal.id, quoteId: quote.id },
    });
    await repo.setDealInvoice(deal.id, "invoiced", invoice.id);
    deal.invoiceStatus = "invoiced";
    deal.invoiceRef = invoice.id;
  } catch (e) {
    logWarn("invoice.create_failed", {
      dealId: deal.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const operator = await repo.getOperator(quote.operatorId);
  const owner = operator ? await repo.getUser(operator.userId) : undefined;
  if (owner) {
    await sendMail(
      owner.email,
      `Deal closed on “${listing?.title ?? "listing"}”`,
      `Buyer accepted your quote of ${quote.currency} ${quote.amount}. Success fee (${(feePct * 100).toFixed(1)}%): ${quote.currency} ${deal.feeAmount}. Invoice pending.`,
    );
  }
  return ok({ quote: await repo.getQuote(id), deal });
}
