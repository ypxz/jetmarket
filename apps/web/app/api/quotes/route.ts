import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logWarn } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { sweepStaleRfqs } from "@/lib/sweep";
import { emailProvider, analyticsProvider } from "@jetmarket/providers";

const CreateQuote = z.object({
  rfqId: z.string().min(1).max(64),
  amount: z.number().positive().max(1e9),
  message: z.string().max(2000).default(""),
});

export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`quote:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);

  const { data, error } = await parseBody(req, CreateQuote);
  if (error) return error;

  // Memory mode has no worker sweep — expire stale RFQs lazily so a
  // dateTo-past request can't keep taking quotes (QA-142).
  await sweepStaleRfqs(repo);
  const rfq = await repo.getRfq(data!.rfqId);
  if (!rfq) return err("rfq not found", 404);
  const listing = await repo.getListing(rfq.listingId);
  // Bearer paths: own the RFQ's listing, or hold a delivered fan-out match.
  // A matched RFQ still references the originating listing for context —
  // if it was deleted there is nothing to quote against.
  if (!listing) return err("rfq not found", 404);
  const allowed =
    listing.operatorId === operator.id ||
    (await repo.hasRfqMatch(rfq.id, operator.id));
  if (!allowed) return err("rfq does not belong to your listings", 403);
  // Live states only — expired/spam/closed RFQs reject new quotes (the iface
  // maps expired→closed in drizzle, so check the iface vocabulary).
  if (!["open", "matched", "quoted"].includes(rfq.status)) {
    return err("rfq is no longer open", 409);
  }

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

  // The quote is persisted — a mail provider blip must not 500 the operator
  // (their retry would 409 on the live-quote guard). Operator sees the quote
  // in their inbox; the buyer's email can be resent later (QA-155).
  try {
    await emailProvider().send({
      to: rfq.buyerEmail,
      subject: `Quote for “${listing.title}” — ${listing.currency} ${data!.amount}`,
      text: `Operator ${operator.name} quoted ${listing.currency} ${data!.amount}.\n${data!.message}\nView and accept: ${process.env.APP_URL ?? new URL(req.url).origin}/quotes?email=${encodeURIComponent(rfq.buyerEmail)}&t=${encodeURIComponent(rfq.accessToken)}`,
    });
  } catch (e) {
    logWarn("quote.buyer_notify_failed", {
      quoteId: quote.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
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
