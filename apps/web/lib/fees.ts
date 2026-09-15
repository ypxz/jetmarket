import { verticalConfig } from "./vertical";

// Fees come from the active VerticalConfig — core code must never hardcode
// vertical-specific values (config.fees.successFeePct is in percent units).

export function successFeePctFor(listingType: string): number {
  const pct = verticalConfig().fees.successFeePct[listingType];
  return (pct ?? 3) / 100;
}

export function planConfig() {
  const plans = verticalConfig().fees.subscriptionPlans;
  const free = plans.find((p) => p.slug === "free") ?? plans[0];
  const pro = plans.find((p) => p.slug === "pro") ?? plans[plans.length - 1];
  return { free, pro };
}

export const FREE_LISTING_LIMIT =
  planConfig().free?.maxListings ?? 3;
export const PRO_PLAN_PRICE_USD =
  planConfig().pro?.monthlyPriceUsd ?? 199;
