import type { ListingType } from "./repo/types";

// Success-fee schedule (jets) — mirrors packages/verticals/jets fees and the
// spec: 3% on closed charters / empty legs, 1.5% on aircraft sales.
export const SUCCESS_FEE_PCT: Record<ListingType, number> = {
  charter: 0.03,
  empty_leg: 0.03,
  aircraft_sale: 0.015,
};

export const PRO_PLAN_PRICE_USD = 199;
export const FREE_LISTING_LIMIT = 3;
