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

/** Operator revised their still-open quote (QA-439): the buyer hears the
 *  new terms — a silent edit would blindside the accept decision. */
export async function notifyBuyerQuoteRevised(
  repo: Repo,
  quote: Quote,
  rfq: Rfq,
): Promise<void> {
  try {
    const listing = rfq.listingId
      ? await repo.getListing(rfq.listingId)
      : undefined;
    const title = listing?.title ?? "a listing";
    const subject = `A quote for “${title}” was revised`;
    const body = `The operator revised their quote for "${title}" on ${site.name} — the new offer is ${quote.currency} ${quote.amount}. Open your quotes link to accept or decline it.`;
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
    logWarn("email.quote_revised_failed", {
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
    // QA-452: the rating surface lives on the buyer inbox — the only moment
    // a buyer is guaranteed to return for is the close mail, so the once-
    // ever stars ride this link (same bearer deep-link as the fan-out mail).
    const origin =
      process.env.APP_URL?.replace(/\/+$/, "") ?? `https://${site.domain}`;
    const rateUrl =
      `${origin}/quotes?email=${encodeURIComponent(rfq.buyerEmail)}` +
      `#t=${encodeURIComponent(rfq.accessToken)}`;
    const rateLine = `Rate how it went — it takes ten seconds and helps the next buyer: ${rateUrl}`;
    const body =
      `You accepted ${operator?.name ?? "the operator"}'s quote of ${quote.currency} ${quote.amount} for "${title}" on ${site.name}. ` +
      contact;
    await emailProvider().send({
      to: rfq.buyerEmail,
      subject,
      text: `${body} ${rateLine}`,
      html: brandedEmailHtml({
        siteName: site.name,
        title: subject,
        paragraphs: [body, rateLine],
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
 * Suspension is the strongest moderation lever (QA-460) — it must never
 * land silently: the operator loses browse supply, fan-out, and writes.
 * Non-fatal like every notify.
 */
export async function notifyOperatorSuspended(
  repo: Repo,
  operatorId: string,
  suspended: boolean,
): Promise<void> {
  try {
    const operator = await repo.getOperator(operatorId);
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    if (!operator || !owner) return;
    const subject = suspended
      ? `Your ${site.name} account was suspended`
      : `Your ${site.name} account was reinstated`;
    const body = suspended
      ? `Our team suspended your operator account "${operator.name}" on ${site.name}. Your listings are hidden from buyers, you will not receive new requests, and listing/quote actions are disabled. Contact support if you believe this was a mistake.`
      : `Your operator account "${operator.name}" on ${site.name} was reinstated — your listings are visible again and new requests will reach you normally.`;
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
    logWarn("email.operator_suspended_failed", {
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

/**
 * Tell the operator the buyer rated their deal (QA-457) — the rate action
 *  rewrites their public ★ record, so the notify rule says they hear about
 *  it. Carries the fresh standing (avg over all rated deals) so a 4★ mail
 *  lands differently than a 1★ one. Non-fatal: mail failure can't 500 the
 *  buyer's rating.
 */
export async function notifyDealRated(
  repo: Repo,
  deal: Deal,
  rating: number,
): Promise<void> {
  try {
    const operator = await repo.getOperator(deal.operatorId);
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    if (!owner) return;
    const summary = await repo
      .ratingSummaryPerOperator([deal.operatorId])
      .then((m) => m[deal.operatorId]);
    const quote = await repo.getQuote(deal.quoteId);
    const rfq = quote ? await repo.getRfq(quote.rfqId) : undefined;
    const listing =
      rfq?.listingId !== undefined && rfq.listingId !== null
        ? await repo.getListing(rfq.listingId)
        : undefined;
    const title = listing?.title ?? "your deal";
    const standing = summary
      ? ` Your rating now stands at ★ ${summary.avg.toFixed(1)} across ${summary.count} rated deal${summary.count === 1 ? "" : "s"}.`
      : "";
    const subject = `The buyer rated your deal ★ ${rating}`;
    const body =
      `The buyer rated your deal on "${title}" ★ ${rating} out of 5 on ${site.name}.${standing}`;
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
    logWarn("email.deal_rated_failed", {
      dealId: deal.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
