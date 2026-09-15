/**
 * Plan limits (spec §"Business model"): free = 3 listings + delayed RFQs;
 * pro = unlimited + instant RFQs. Concrete plans come from
 * VerticalConfig.fees.subscriptionPlans (jets: free delay = 24h);
 * `defaultPlans` mirrors that pair for callers without a config at hand.
 */
import type { Plan } from "./vertical-config";

export const FREE_PLAN_ID = "free";
export const PRO_PLAN_ID = "pro";

/** Additional RFQ delivery delay for unverified operators, any plan. */
export const UNVERIFIED_RFQ_DELAY_MINUTES = 360;

/** Generic free/pro pair — same shape the jets config declares. */
export function defaultPlans(): Plan[] {
  return [
    {
      slug: FREE_PLAN_ID,
      nameKey: "plans.free.name",
      monthlyPriceUsd: 0,
      maxListings: 3,
      featuresKey: "plans.free.features",
      rfqDelayHours: 24,
    },
    {
      slug: PRO_PLAN_ID,
      nameKey: "plans.pro.name",
      monthlyPriceUsd: 199,
      maxListings: null,
      featuresKey: "plans.pro.features",
    },
  ];
}

export function planById(plans: Plan[], slug: string): Plan | undefined {
  return plans.find((p) => p.slug === slug);
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
  const planDelay = Math.round((plan.rfqDelayHours ?? 0) * 60);
  return Math.max(
    planDelay,
    verified ? 0 : UNVERIFIED_RFQ_DELAY_MINUTES,
  );
}

export type Delivery = "instant" | "delayed";

export function deliveryFor(plan: Plan, verified: boolean): Delivery {
  return rfqDeliveryDelayMinutes(plan, verified) === 0
    ? "instant"
    : "delayed";
}
