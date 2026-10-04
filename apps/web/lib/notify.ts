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
    const listing: Listing | undefined = rfq.listingId
      ? await repo.getListing(rfq.listingId)
      : undefined;
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
    const listing = rfq.listingId
      ? await repo.getListing(rfq.listingId)
      : undefined;
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
  const listing = rfq.listingId
    ? await repo.getListing(rfq.listingId)
    : undefined;
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
    // The winning operator gets the buyer's email — the buyer needs the same
    // reach-back path or a silent operator leaves the deal stranded (QA-243).
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    const subject = `You accepted a quote for “${title}”`;
    const contact = owner
      ? `Reach them directly at ${owner.email} — they have also been notified.`
      : "The operator has been notified and will contact you to arrange fulfilment.";
    const body =
      `You accepted ${operator?.name ?? "the operator"}'s quote of ${quote.currency} ${quote.amount} for "${title}" on ${site.name}. ` +
      contact;
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

/**
 * Tell an operator that moderation paused or archived their listing — the
 * listing disappears from public search otherwise with no signal to the
 * owner. Buyers are never notified here (no buyer attachment to a listing
 * outside an RFQ). Failures never fail the admin request.
 */
export async function notifyListingModerated(
  repo: Repo,
  listing: Listing,
  status: "paused" | "archived",
): Promise<void> {
  try {
    const operator = await repo.getOperator(listing.operatorId);
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    if (!owner) return;
    const subject = `Your listing “${listing.title}” was ${status} by moderation`;
    const body =
      status === "paused"
        ? `Our moderation team paused your listing "${listing.title}" on ${site.name}, so it is hidden from public search. Review its details and contact support if you believe this was a mistake — you can reactivate it from your dashboard.`
        : `Our moderation team archived your listing "${listing.title}" on ${site.name}, so it is no longer listed. Contact support if you believe this was a mistake.`;
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
    logWarn("email.listing_moderated_failed", {
      listingId: listing.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Tell an operator their verified badge was granted or removed — a trust
 * signal change that should never land silently (QA-249).
 */
export async function notifyOperatorVerified(
  repo: Repo,
  operatorId: string,
  verified: boolean,
): Promise<void> {
  try {
    const operator = await repo.getOperator(operatorId);
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    if (!operator || !owner) return;
    const subject = verified
      ? `Your operator profile was verified`
      : `Your operator profile is no longer verified`;
    const body = verified
      ? `Our team verified your operator profile "${operator.name}" on ${site.name} — the verified badge now shows on your listings and public profile.`
      : `Our team removed the verified badge from your operator profile "${operator.name}" on ${site.name}. Contact support if you believe this was a mistake.`;
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
    logWarn("email.operator_verified_failed", {
      operatorId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Tell an operator their success-fee invoice was voided (dispute/refund) —
 * the dashboard row would otherwise just flip state silently (QA-249).
 */
export async function notifyDealInvoiceVoided(
  repo: Repo,
  deal: Deal,
): Promise<void> {
  try {
    const operator = await repo.getOperator(deal.operatorId);
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    if (!owner) return;
    const subject = `Success-fee invoice voided — deal ${deal.id.slice(0, 8)}`;
    const body =
      `Your success-fee invoice${deal.invoiceRef ? ` (${deal.invoiceRef})` : ""} ` +
      `of ${deal.currency} ${deal.feeAmount} for the ${deal.currency} ${deal.amount} deal was voided — you owe no fee on it. Contact support if you have questions.`;
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
    logWarn("email.deal_invoice_voided_failed", {
      dealId: deal.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
