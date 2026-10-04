import { site } from "@jetmarket/config";
import { localePath, mailCopy, mailT } from "@jetmarket/i18n";
import { brandedEmailHtml, emailProvider } from "@jetmarket/providers";
import { logWarn } from "@/lib/log";
import { searchAlertSearchUrl } from "@/lib/search-alerts";
import type { Deal, Listing, Quote, Repo, Rfq } from "@/lib/repo/types";

/**
 * Tell the operator their quote was not selected — either the buyer declined
 * it explicitly, the buyer accepted a competing quote on the same RFQ,
 * the buyer closed the request outright, or the listing went terminal
 * (sold/archived — QA-499's orphan sweep).
 * Email failures never fail the request; the status change already landed.
 */
export async function notifyQuoteDeclined(
  repo: Repo,
  quote: Quote,
  rfq: Rfq,
  reason: "declined" | "competing-accepted" | "rfq-closed" | "listing-ended",
  /** QA-508: buyer-picked decline reason — only meaningful on "declined";
   *  adds a localized "Reason given: …" line so the op learns why. */
  buyerReason?: string,
): Promise<void> {
  try {
    const operator = await repo.getOperator(quote.operatorId);
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    if (!owner) return;
    const listing: Listing | undefined = rfq.listingId
      ? await repo.getListing(rfq.listingId)
      : undefined;
    const m = await mailCopy(owner.locale);
    const title = listing?.title ?? mailT(m, "shared.aListing");
    const subject = mailT(
      m,
      reason === "competing-accepted"
        ? "opQuoteDeclined.subjectAccepted"
        : reason === "rfq-closed"
          ? "opQuoteDeclined.subjectClosed"
          : reason === "listing-ended"
            ? "opQuoteDeclined.subjectEnded"
            : "opQuoteDeclined.subjectDeclined",
      { title },
    );
    const body = mailT(
      m,
      reason === "competing-accepted"
        ? "opQuoteDeclined.bodyAccepted"
        : reason === "rfq-closed"
          ? "opQuoteDeclined.bodyClosed"
          : reason === "listing-ended"
            ? "opQuoteDeclined.bodyEnded"
            : "opQuoteDeclined.bodyDeclined",
      {
        title,
        site: site.name,
        currency: quote.currency,
        amount: quote.amount,
      },
    );
    // QA-508: a named decline reason beats a bare verdict — append the
    // buyer's own words (localized enum label) to the body.
    const reasonLine =
      reason === "declined" && buyerReason
        ? `\n\n${mailT(m, "opQuoteDeclined.reasonLine", {
            reason: mailT(m, `opQuoteDeclined.reason_${buyerReason}`),
          })}`
        : "";
    await emailProvider().send({
      to: owner.email,
      subject,
      text: body + reasonLine,
      html: brandedEmailHtml({
        siteName: site.name,
        title: subject,
        paragraphs: reasonLine ? [body, reasonLine.trim()] : [body],
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
 * Tell the operator the buyer countered their live quote (QA-511) —
 * the negotiation signal that turns a would-be decline into a revised
 * offer. Non-fatal like every notify: the counter is already stamped.
 */
export async function notifyQuoteCountered(
  repo: Repo,
  quote: Quote,
  rfq: Rfq,
  counterAmount: number,
): Promise<void> {
  try {
    const operator = await repo.getOperator(quote.operatorId);
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    if (!owner) return;
    const listing: Listing | undefined = rfq.listingId
      ? await repo.getListing(rfq.listingId)
      : undefined;
    const m = await mailCopy(owner.locale);
    const title = listing?.title ?? mailT(m, "shared.aListing");
    const subject = mailT(m, "opQuoteCountered.subject", { title });
    const body = mailT(m, "opQuoteCountered.body", {
      title,
      site: site.name,
      currency: quote.currency,
      amount: quote.amount,
      counterAmount,
    });
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
    logWarn("email.quote_countered_failed", {
      quoteId: quote.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Tell the operator the buyer withdrew their counter (QA-518) — they got
 * the counter mail and may be mid-reply; a silent clear leaves them
 * negotiating against a ghost. Same owner-locale path as the counter.
 */
export async function notifyCounterWithdrawn(
  repo: Repo,
  quote: Quote,
  rfq: Rfq,
  counterAmount: number,
): Promise<void> {
  try {
    const operator = await repo.getOperator(quote.operatorId);
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    if (!owner) return;
    const listing: Listing | undefined = rfq.listingId
      ? await repo.getListing(rfq.listingId)
      : undefined;
    const m = await mailCopy(owner.locale);
    const title = listing?.title ?? mailT(m, "shared.aListing");
    const subject = mailT(m, "opCounterWithdrawn.subject", { title });
    const body = mailT(m, "opCounterWithdrawn.body", {
      title,
      site: site.name,
      currency: quote.currency,
      amount: quote.amount,
      counterAmount,
    });
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
    logWarn("email.counter_withdrawn_failed", {
      quoteId: quote.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Tell the buyer the operator declined their counter (QA-519) — the
 * answer to a lowball that isn't silence: the chip clears and the mail
 * says the ask still stands. Buyer mails read the RFQ's stamped locale.
 */
export async function notifyCounterDeclined(
  repo: Repo,
  quote: Quote,
  rfq: Rfq,
  counterAmount: number,
): Promise<void> {
  try {
    const listing = rfq.listingId
      ? await repo.getListing(rfq.listingId)
      : undefined;
    const m = await mailCopy(rfq.locale);
    const title = listing?.title ?? mailT(m, "shared.aListing");
    const subject = mailT(m, "counterDeclined.subject", { title });
    const body = mailT(m, "counterDeclined.body", {
      title,
      site: site.name,
      currency: quote.currency,
      amount: quote.amount,
      counterAmount,
    });
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
    logWarn("email.counter_declined_failed", {
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
    // QA-493: buyer mails read the RFQ's stamped locale.
    const m = await mailCopy(rfq.locale);
    const title = listing?.title ?? mailT(m, "shared.aListing");
    const subject = mailT(m, "quoteWithdrawn.subject", { title });
    const body = mailT(m, "quoteWithdrawn.body", {
      currency: quote.currency,
      amount: quote.amount,
      title,
      site: site.name,
    });
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
    const m = await mailCopy(rfq.locale);
    const title = listing?.title ?? mailT(m, "shared.aListing");
    const subject = mailT(m, "quoteRevised.subject", { title });
    const body = mailT(m, "quoteRevised.body", {
      title,
      site: site.name,
      currency: quote.currency,
      amount: quote.amount,
    });
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
      const m = await mailCopy(owner.locale);
      const invoiceNote =
        deal.invoiceStatus === "invoiced" && deal.invoiceRef
          ? mailT(m, "opDealClosed.invoiceNote", {
              currency: quote.currency,
              fee: deal.feeAmount,
              ref: deal.invoiceRef,
            })
          : "";
      const subject = mailT(m, "opDealClosed.subject", { title });
      const body = mailT(m, "opDealClosed.body", {
        currency: quote.currency,
        amount: quote.amount,
        title,
        site: site.name,
        buyer: rfq.buyerEmail,
        invoiceNote,
      });
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
    const m = await mailCopy(rfq.locale);
    const subject = mailT(m, "dealClosed.subject", { title });
    const contact = owner
      ? mailT(m, "dealClosed.contact", { email: owner.email })
      : mailT(m, "dealClosed.contactFallback");
    // QA-452: the rating surface lives on the buyer inbox — the only moment
    // a buyer is guaranteed to return for is the close mail, so the once-
    // ever stars ride this link (same bearer deep-link as the fan-out mail).
    const origin =
      process.env.APP_URL?.replace(/\/+$/, "") ?? `https://${site.domain}`;
    const rateUrl =
      `${origin}${localePath(rfq.locale, "/quotes")}?email=${encodeURIComponent(rfq.buyerEmail)}` +
      `#t=${encodeURIComponent(rfq.accessToken)}`;
    const rateLine = mailT(m, "dealClosed.rate", { url: rateUrl });
    const body =
      mailT(m, "dealClosed.body", {
        operator: operator?.name ?? mailT(m, "shared.theOperator"),
        currency: quote.currency,
        amount: quote.amount,
        title,
        site: site.name,
      }) + ` ${contact}`;
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
    const m = await mailCopy(owner.locale);
    const statusWord = mailT(
      m,
      status === "paused" ? "opListingModerated.paused" : "opListingModerated.archived",
    );
    const subject = mailT(m, "opListingModerated.subject", {
      title: listing.title,
      status: statusWord,
    });
    const body = mailT(
      m,
      status === "paused" ? "opListingModerated.bodyPaused" : "opListingModerated.bodyArchived",
      { title: listing.title, site: site.name },
    );
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
    const m = await mailCopy(owner.locale);
    const subject = mailT(
      m,
      verified ? "opVerified.subjectOn" : "opVerified.subjectOff",
    );
    const body = mailT(m, verified ? "opVerified.bodyOn" : "opVerified.bodyOff", {
      name: operator.name,
      site: site.name,
    });
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
    const m = await mailCopy(owner.locale);
    const subject = mailT(
      m,
      suspended ? "opSuspended.subjectOn" : "opSuspended.subjectOff",
      { site: site.name },
    );
    const body = mailT(
      m,
      suspended ? "opSuspended.bodyOn" : "opSuspended.bodyOff",
      { name: operator.name, site: site.name },
    );
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
    const m = await mailCopy(owner.locale);
    const subject = mailT(m, "opInvoiceVoided.subject", {
      id: deal.id.slice(0, 8),
    });
    const body = mailT(m, "opInvoiceVoided.body", {
      refParen: deal.invoiceRef
        ? mailT(m, "shared.refParen", { ref: deal.invoiceRef })
        : "",
      currency: deal.currency,
      fee: deal.feeAmount,
      amount: deal.amount,
    });
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
    const m = await mailCopy(owner.locale);
    const title = listing?.title ?? mailT(m, "shared.yourDeal");
    const standing = summary
      ? mailT(
          m,
          summary.count === 1 ? "opDealRated.standingOne" : "opDealRated.standingMany",
          { avg: summary.avg.toFixed(1), count: summary.count },
        )
      : "";
    const subject = mailT(m, "opDealRated.subject", { rating });
    const body = mailT(m, "opDealRated.body", {
      title,
      rating,
      site: site.name,
      standing,
    });
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

/**
 * QA-500: tell the BUYER their request died with its listing — the orphan
 * sweep (QA-499) closes sibling RFQs on a sold/archived listing the buyer
 * never closed, so silently rendering 'closed' reads like a bug. One mail
 * with a same-type browse CTA in the RFQ's stamped locale. Non-fatal.
 */
export async function notifyBuyerRfqEnded(
  rfq: Rfq,
  listing: Listing,
  origin: string,
): Promise<void> {
  try {
    const m = await mailCopy(rfq.locale);
    const subject = mailT(m, "rfqListingEnded.subject", {
      title: listing.title,
    });
    const intro = mailT(m, "rfqListingEnded.intro", {
      site: site.name,
      title: listing.title,
    });
    const url = searchAlertSearchUrl(
      origin,
      { type: listing.type },
      rfq.locale,
    );
    await emailProvider().send({
      to: rfq.buyerEmail,
      subject,
      text: `${intro}\n\n${mailT(m, "rfqListingEnded.browse", { url })}`,
      html: brandedEmailHtml({
        siteName: site.name,
        title: subject,
        paragraphs: [intro],
        cta: { url, label: mailT(m, "rfqListingEnded.cta") },
      }),
    });
  } catch (e) {
    logWarn("email.rfq_listing_ended_failed", {
      rfqId: rfq.id,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
