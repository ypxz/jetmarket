import { z } from "zod";
import { site } from "@jetmarket/config";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logWarn } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { sweepStaleRfqs } from "@/lib/sweep";
import {
  brandedEmailHtml,
  emailProvider,
  analyticsProvider,
} from "@jetmarket/providers";
import { appOrigin } from "@/lib/origin";
import { verticalSlug } from "@/lib/vertical";

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
  // QA-460: a suspended operator cannot quote new demand.
  if (operator.suspended) return err("account suspended", 403);

  const { data, error } = await parseBody(req, CreateQuote);
  if (error) return error;

  // Memory mode has no worker sweep — expire stale RFQs lazily so a
  // dateTo-past request can't keep taking quotes (QA-142).
  await sweepStaleRfqs(repo);
  const rfq = await repo.getRfq(data!.rfqId);
  // Foreign-vertical RFQs 404 here — on a shared DB an operator with a
  // machinery match could otherwise quote through the wrong deploy
  // (QA-298).
  if (!rfq || rfq.vertical !== verticalSlug()) return err("rfq not found", 404);
  const listing = rfq.listingId
    ? await repo.getListing(rfq.listingId)
    : undefined;
  // Bearer paths: own the RFQ's listing, or hold a delivered fan-out match.
  // A matched RFQ still references the originating listing for context —
  // if it was deleted there is nothing to quote against.
  if (!listing) return err("rfq not found", 404);
  // Archiving is terminal (QA-247): a delisted item must stop minting new
  // quotes — its still-open RFQs now expire out instead (QA-300).
  if (listing.status === "archived") return err("rfq is no longer open", 409);
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
    const inboxUrl = `${appOrigin(req)}/quotes?email=${encodeURIComponent(rfq.buyerEmail)}#t=${encodeURIComponent(rfq.accessToken)}`;
    const quoteSubject = `Quote for “${listing.title}” — ${listing.currency} ${data!.amount}`;
    await emailProvider().send({
      to: rfq.buyerEmail,
      subject: quoteSubject,
      text: `Operator ${operator.name} quoted ${listing.currency} ${data!.amount}.\n${data!.message}\nView and accept: ${inboxUrl}`,
      html: brandedEmailHtml({
        siteName: site.name,
        title: quoteSubject,
        paragraphs: [
          `Operator ${operator.name} quoted ${listing.currency} ${data!.amount}.`,
          ...(data!.message ? [data!.message] : []),
        ],
        cta: { url: inboxUrl, label: "View and accept" },
      }),
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
