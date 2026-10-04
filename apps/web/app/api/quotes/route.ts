import { z } from "zod";
import { site } from "@jetmarket/config";
import { localePath, mailCopy, mailT } from "@jetmarket/i18n";
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
import { isExpiredListing } from "@/lib/search";
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
  // Archiving AND sold are terminal (QA-247, QA-498): a delisted item must
  // stop minting new quotes — its still-open RFQs now expire out instead
  // (QA-300). 'sold' reaches here only via legacy rows, since QA-499 sweeps
  // the live RFQs on the terminal flip.
  if (listing.status === "archived" || listing.status === "sold")
    return err("rfq is no longer open", 409);
  const allowed =
    listing.operatorId === operator.id ||
    (await repo.hasRfqMatch(rfq.id, operator.id));
  if (!allowed) return err("rfq does not belong to your listings", 403);
  // QA-504: the owner's own quote on their expired listing can never mint
  // a deal (QA-502 blocks it at accept) — don't let them create a dead
  // quote; re-dating the listing relives it. Fan-out ops aren't gated:
  // their quotes serve the buyer on their own aircraft.
  if (
    listing.operatorId === operator.id &&
    isExpiredListing(listing)
  ) {
    return err("listing expired — update its date to relist", 409);
  }
  // Live states only — expired/spam/closed RFQs reject new quotes (the iface
  // maps expired→closed in drizzle, so check the iface vocabulary).
  if (!["open", "matched", "quoted"].includes(rfq.status)) {
    return err("rfq is no longer open", 409);
  }
  // Buyer pause (QA-533) freezes NEW offer intake — existing quotes stay
  // live, so only this create path checks the stamp.
  if (rfq.pausedAt) {
    return err("rfq is not accepting new offers", 409);
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
    const inboxUrl = `${appOrigin(req)}${localePath(rfq.locale, "/quotes")}?email=${encodeURIComponent(rfq.buyerEmail)}#t=${encodeURIComponent(rfq.accessToken)}`;
    // QA-493: buyer mails read the RFQ's stamped locale.
    const m = await mailCopy(rfq.locale);
    const quoteSubject = mailT(m, "quoteReceived.subject", {
      title: listing.title,
      currency: listing.currency,
      amount: data!.amount,
    });
    const quotedLine = mailT(m, "quoteReceived.intro", {
      name: operator.name,
      currency: listing.currency,
      amount: data!.amount,
    });
    await emailProvider().send({
      to: rfq.buyerEmail,
      subject: quoteSubject,
      text: `${quotedLine}\n${data!.message}\n${mailT(m, "quoteReceived.cta")}: ${inboxUrl}`,
      html: brandedEmailHtml({
        siteName: site.name,
        title: quoteSubject,
        paragraphs: [
          quotedLine,
          ...(data!.message ? [data!.message] : []),
        ],
        cta: { url: inboxUrl, label: mailT(m, "quoteReceived.cta") },
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
