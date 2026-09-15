/**
 * Plans, prices, and per-plan usage limits for JetMarket operators.
 * The single source of truth the pricing page, plan-limit checks and the
 * payments adapter all read. Currency formatting lives in @jetmarket/i18n.
 */
export type PlanId = "free" | "pro";

export type QuotaKey = "listings" | "rfqs_per_hour" | "rfq_delay_minutes";

export interface Plan {
  id: PlanId;
  /** i18n message key under `pricing.plans.<id>` */
  nameKey: string;
  /** monthly price in minor units (cents) */
  priceCents: number;
  currency: "USD" | "EUR" | "CHF";
  /** Stripe price id for the real adapter (env-overridable) */
  stripePriceId?: string;
  /** -1 = unlimited */
  quotas: Partial<Record<QuotaKey, number>>;
  features: string[];
}

export const plans: Record<PlanId, Plan> = {
  free: {
    id: "free",
    nameKey: "free",
    priceCents: 0,
    currency: "USD",
    quotas: { listings: 3, rfq_delay_minutes: 360 },
    features: ["3 active listings", "Delayed RFQ delivery", "Verified badge eligible"],
  },
  pro: {
    id: "pro",
    nameKey: "pro",
    priceCents: 19900,
    currency: "USD",
    quotas: { listings: -1, rfq_delay_minutes: 0 },
    features: [
      "Unlimited listings",
      "Instant RFQ delivery",
      "Pro badge + featured placement",
      "Priority support",
    ],
  },
};

export const defaultPlan: PlanId = "free";

export function isPlanId(value: string): value is PlanId {
  return value === "free" || value === "pro";
}
