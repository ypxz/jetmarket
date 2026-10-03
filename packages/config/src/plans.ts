/**
 * Billing-side plan identity for the payments adapter: which currency
 * checkout charges in and (for Stripe) the provider's price id.
 *
 * Plan *semantics* — the price shown to users, listing limits, RFQ delay —
 * live in `VerticalConfig.fees.subscriptionPlans` and nowhere else. This
 * file deliberately carries none of them: the previous copy did (quotas,
 * feature strings, cents price) and drifted (rfq_delay_minutes: 360 vs the
 * vertical's 24h) while nothing read it (QA-221).
 */
export type PlanId = "free" | "pro";

export interface BillingPlan {
  id: PlanId;
  /** Charge currency for checkout — a EUR marketplace can bill Pro in USD. */
  currency: "USD" | "EUR" | "CHF";
  /** Stripe price id for the real adapter (env-overridable). */
  stripePriceId?: string;
}

export const plans: Record<PlanId, BillingPlan> = {
  free: { id: "free", currency: "USD" },
  pro: { id: "pro", currency: "USD" },
};

/** Buyer concierge — the marketplace's own per-request fee ($49 expedite).
 *  Charged in USD like Pro even on a EUR-currency vertical. */
export const CONCIERGE_PRICE_USD = 49;
