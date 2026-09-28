import { site } from "@jetmarket/config";
import { brandedEmailHtml, emailProvider } from "@jetmarket/providers";
import { logWarn } from "@/lib/log";
import type { Deal, Listing, Quote, Repo, Rfq } from "@/lib/repo/types";

/**
 * Tell the operator their quote was not selected — either the buyer declined
 * it explicitly, the buyer accepted a competing quote on the same RFQ, or
 * the buyer closed the request outright.
 * Email failures never fail the request; the status change already landed.
 */
export async function notifyQuoteDeclined(
  repo: Repo,
  quote: Quote,
  rfq: Rfq,
  reason: "declined" | "competing-accepted" | "rfq-closed",
): Promise<void> {
  try {
    const operator = await repo.getOperator(quote.operatorId);
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    if (!owner) return;
    const listing: Listing | undefined = await repo.getListing(rfq.listingId);
    const title = listing?.title ?? "a listing";
    const subject =
      reason === "competing-accepted"
        ? `The buyer accepted another quote for “${title}”`
        : reason === "rfq-closed"
          ? `The buyer closed their request for “${title}”`
          : `Your quote for “${title}” was declined`;
    const body =
      reason === "competing-accepted"
        ? `The buyer accepted a different quote for "${title}" on ${site.name}, so your quote of ${quote.currency} ${quote.amount} was not selected this time.`
        : reason === "rfq-closed"
          ? `The buyer closed their request for "${title}" on ${site.name}, so your quote of ${quote.currency} ${quote.amount} was not selected this time.`
          : `The buyer declined your quote of ${quote.currency} ${quote.amount} for "${title}" on ${site.name}.`;
    await emailProvider().send({
      to: owner.email,
      subject,
      text: body,
      html: brandedEmailHtml({
        siteName: site.name,
        title: subject,
        paragraphs: [body],
      }),
    });
  } catch (e) {
    logWarn("email.quote_declined_failed", {
      quoteId: quote.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Tell the buyer an operator withdrew a quote they had sent. Buyers are
 * unauthenticated, so email is the only channel that reaches them.
 */
export async function notifyBuyerQuoteWithdrawn(
  repo: Repo,
  quote: Quote,
  rfq: Rfq,
): Promise<void> {
  try {
    const listing = await repo.getListing(rfq.listingId);
    const title = listing?.title ?? "a listing";
    const subject = `A quote for “${title}” was withdrawn`;
    const body = `The operator withdrew their quote of ${quote.currency} ${quote.amount} for "${title}" on ${site.name}. Other quotes on your request are unaffected.`;
    await emailProvider().send({
      to: rfq.buyerEmail,
      subject,
      text: body,
      html: brandedEmailHtml({
        siteName: site.name,
        title: subject,
        paragraphs: [body],
      }),
    });
  } catch (e) {
    logWarn("email.quote_withdrawn_failed", {
      quoteId: quote.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Deal closed: the winning operator learns the sale landed (and the
 * success-fee invoice ref when already issued); the buyer gets an
 * acceptance confirmation — their only receipt, since buyers are
 * unauthenticated (QA-149). Failures never fail the request.
 */
export async function notifyDealClosed(
  repo: Repo,
  quote: Quote,
  rfq: Rfq,
  deal: Deal,
): Promise<void> {
  const listing = await repo.getListing(rfq.listingId);
  const title = listing?.title ?? "a listing";
  try {
    const operator = await repo.getOperator(quote.operatorId);
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    if (owner) {
      const invoiceNote =
        deal.invoiceStatus === "invoiced" && deal.invoiceRef
          ? ` A success-fee invoice for ${quote.currency} ${deal.feeAmount} (${deal.invoiceRef}) has been issued to your account.`
          : "";
      const subject = `Your quote for “${title}” was accepted`;
      const body =
        `The buyer accepted your quote of ${quote.currency} ${quote.amount} for "${title}" on ${site.name}. ` +
        `Contact them at ${rfq.buyerEmail} to arrange fulfilment.${invoiceNote}`;
      await emailProvider().send({
        to: owner.email,
        subject,
        text: body,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body],
        }),
      });
    }
  } catch (e) {
    logWarn("email.deal_closed_operator_failed", {
      dealId: deal.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    const operator = await repo.getOperator(quote.operatorId);
    const subject = `You accepted a quote for “${title}”`;
    const body =
      `You accepted ${operator?.name ?? "the operator"}'s quote of ${quote.currency} ${quote.amount} for "${title}" on ${site.name}. ` +
      `The operator has been notified and will contact you to arrange fulfilment.`;
    await emailProvider().send({
      to: rfq.buyerEmail,
      subject,
      text: body,
      html: brandedEmailHtml({
        siteName: site.name,
        title: subject,
        paragraphs: [body],
      }),
    });
  } catch (e) {
    logWarn("email.deal_closed_buyer_failed", {
      dealId: deal.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
