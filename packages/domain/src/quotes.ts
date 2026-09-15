/**
 * Quote lifecycle state machine + deal creation.
 *
 *   draft ──► sent ──► accepted ──► (Deal created via acceptQuote)
 *     │        ├──► declined
 *     │        ├──► expired
 *     └──────► └──► withdrawn
 */
import { successFeeAmount, successFeePctFor } from "./fees";
import type { Currency } from "./money";
import type { Deal, Quote, QuoteStatus } from "./types";
import type { VerticalConfig } from "./vertical-config";

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "withdrawn",
] as const satisfies readonly QuoteStatus[];

export const TERMINAL_QUOTE_STATUSES = [
  "accepted",
  "declined",
  "expired",
  "withdrawn",
] as const satisfies readonly QuoteStatus[];

const TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft: ["sent", "withdrawn"],
  sent: ["accepted", "declined", "expired", "withdrawn"],
  accepted: [],
  declined: [],
  expired: [],
  withdrawn: [],
};

export class InvalidQuoteTransition extends Error {
  readonly from: QuoteStatus;
  readonly to: QuoteStatus;
  constructor(from: QuoteStatus, to: QuoteStatus) {
    super(`invalid quote transition: ${from} -> ${to}`);
    this.name = "InvalidQuoteTransition";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionQuote(
  from: QuoteStatus,
  to: QuoteStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalQuoteStatus(s: QuoteStatus): boolean {
  return TRANSITIONS[s].length === 0;
}

/** Returns a new Quote with status applied; throws InvalidQuoteTransition. */
export function transitionQuote(
  quote: Quote,
  to: QuoteStatus,
  at: Date = new Date(),
): Quote {
  if (!canTransitionQuote(quote.status, to)) {
    throw new InvalidQuoteTransition(quote.status, to);
  }
  return { ...quote, status: to, updatedAt: at };
}

export interface AcceptQuoteInput {
  /** Listing type the quote covers — selects the fee rate. */
  listingType: string;
  /** Deal id — injected so the caller stays in charge of identity. */
  dealId: string;
  at?: Date;
}

/**
 * Accept a sent quote and derive the Deal with success fee per the vertical
 * config (3% charter/empty_leg, 1.5% aircraft_sale for jets).
 */
export function acceptQuote(
  config: Pick<VerticalConfig, "fees">,
  quote: Quote,
  input: AcceptQuoteInput,
): { quote: Quote; deal: Deal } {
  const accepted = transitionQuote(quote, "accepted", input.at ?? new Date());
  const pct = successFeePctFor(config, input.listingType);
  return {
    quote: accepted,
    deal: {
      id: input.dealId,
      quoteId: quote.id,
      closedAt: input.at ?? new Date(),
      feePct: pct,
      feeAmountMinor: successFeeAmount(quote.amountMinor, pct),
      currency: quote.currency as Currency,
      invoiceStatus: "pending",
      invoiceRef: null,
    },
  };
}
