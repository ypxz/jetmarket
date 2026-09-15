/**
 * Plan limits (spec §"Business model"): free = 3 listings + delayed RFQs;
 * pro = unlimited + instant RFQs. Concrete plans come from
 * VerticalConfig.fees.subscriptionPlans; `defaultPlans` gives callers the
 * generic free/pro pair used by the jets config and tests.
 */
import type { Currency } from "./money";
import type { Plan } from "./vertical-config";

export const FREE_PLAN_ID = "free";
export const PRO_PLAN_ID = "pro";

/** Default RFQ delivery delay for the free tier. */
export const FREE_RFQ_DELAY_MINUTES = 360;
/** Additional delay for unverified operators regardless of plan. */
export const UNVERIFIED_RFQ_DELAY_MINUTES = 360;

export function defaultPlans(currency: Currency = "USD"): Plan[] {
  return [
    {
      id: FREE_PLAN_ID,
      name: "Free",
      priceMinor: 0,
      currency,
      maxListings: 3,
      rfqDelayMinutes: FREE_RFQ_DELAY_MINUTES,
    },
    {
      id: PRO_PLAN_ID,
      name: "Pro",
      priceMinor: 19_900,
      currency,
      maxListings: null,
      rfqDelayMinutes: 0,
    },
  ];
}

export function planById(plans: Plan[], id: string): Plan | undefined {
  return plans.find((p) => p.id === id);
}

export interface PlanLimitResult {
  allowed: boolean;
  reason?: "listing_limit";
  maxListings?: number;
}

/** Whether an operator may activate one more listing on this plan. */
export function canCreateListing(
  plan: Plan,
  currentActiveListings: number,
): PlanLimitResult {
  if (plan.maxListings === null) return { allowed: true };
  if (currentActiveListings < plan.maxListings) return { allowed: true };
  return {
    allowed: false,
    reason: "listing_limit",
    maxListings: plan.maxListings,
  };
}

/**
 * RFQ delivery delay in minutes: max(plan delay, unverified delay). Verified
 * pro operators get 0 (instant); everyone else waits.
 */
export function rfqDeliveryDelayMinutes(
  plan: Plan,
  verified: boolean,
): number {
  return Math.max(
    plan.rfqDelayMinutes,
    verified ? 0 : UNVERIFIED_RFQ_DELAY_MINUTES,
  );
}

export type Delivery = "instant" | "delayed";

export function deliveryFor(plan: Plan, verified: boolean): Delivery {
  return rfqDeliveryDelayMinutes(plan, verified) === 0
    ? "instant"
    : "delayed";
}
