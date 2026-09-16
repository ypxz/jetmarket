import { z } from "zod";
import { err, ok, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { emailProvider, analyticsProvider } from "@jetmarket/providers";

const CreateQuote = z.object({
  rfqId: z.string().min(1),
  amount: z.number().positive(),
  message: z.string().max(2000).default(""),
});

export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);

  const { data, error } = await parseBody(req, CreateQuote);
  if (error) return error;

  const rfq = await repo.getRfq(data!.rfqId);
  if (!rfq) return err("rfq not found", 404);
  const listing = await repo.getListing(rfq.listingId);
  if (!listing || listing.operatorId !== operator.id) {
    return err("rfq does not belong to your listings", 403);
  }
  if (rfq.status === "closed") return err("rfq already closed", 409);

  // One live quote per operator per rfq; a declined/withdrawn one may be
  // re-quoted (partial-unique index backs the same invariant — the catch
  // turns a lost race into the same clean 409).
  const mine = await repo.listQuotes({ rfqId: rfq.id, operatorId: operator.id });
  if (mine.some((q) => q.status === "sent" || q.status === "accepted")) {
    return err("you already have a live quote on this rfq", 409);
  }
  let quote;
  try {
    quote = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: operator.id,
      amount: data!.amount,
      currency: listing.currency,
      message: data!.message ?? "",
    });
  } catch (e) {
    // Drizzle wraps driver errors — the pg code sits on the cause.
    const code =
      (e as { code?: string }).code ??
      (e as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") {
      return err("you already have a live quote on this rfq", 409);
    }
    throw e;
  }

  await emailProvider().send({
    to: rfq.buyerEmail,
    subject: `Quote for “${listing.title}” — ${listing.currency} ${data!.amount}`,
    text: `Operator ${operator.name} quoted ${listing.currency} ${data!.amount}.\n${data!.message}\nView and accept: ${process.env.APP_URL ?? ""}/quotes?email=${encodeURIComponent(rfq.buyerEmail)}`,
  });
  analyticsProvider().track({
    name: "quote_sent",
    props: {
      quoteId: quote.id,
      rfqId: rfq.id,
      amount: quote.amount,
      currency: quote.currency,
    },
  });
  return ok(quote, 201);
}
