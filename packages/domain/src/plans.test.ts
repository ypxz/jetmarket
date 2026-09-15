import { describe, expect, it } from "vitest";
import {
  canCreateListing,
  defaultPlans,
  deliveryFor,
  planById,
  rfqDeliveryDelayMinutes,
  FREE_PLAN_ID,
  PRO_PLAN_ID,
} from "./plans";

describe("plans", () => {
  const [free, pro] = defaultPlans();

  it("ships a generic free/pro pair matching the spec", () => {
    expect(free).toMatchObject({
      slug: FREE_PLAN_ID,
      maxListings: 3,
      rfqDelayHours: 24,
      monthlyPriceUsd: 0,
    });
    expect(pro).toMatchObject({
      slug: PRO_PLAN_ID,
      maxListings: null,
      monthlyPriceUsd: 199,
    });
  });

  it("looks plans up by slug", () => {
    expect(planById(defaultPlans(), "pro")?.nameKey).toBe("plans.pro.name");
    expect(planById(defaultPlans(), "nope")).toBeUndefined();
  });

  it("enforces the free 3-listing cap", () => {
    expect(canCreateListing(free!, 0).allowed).toBe(true);
    expect(canCreateListing(free!, 2).allowed).toBe(true);
    const blocked = canCreateListing(free!, 3);
    expect(blocked).toEqual({
      allowed: false,
      reason: "listing_limit",
      maxListings: 3,
    });
  });

  it("pro is unlimited", () => {
    expect(canCreateListing(pro!, 10_000).allowed).toBe(true);
  });

  it("delays RFQs for free and unverified, instant for verified pro", () => {
    expect(rfqDeliveryDelayMinutes(free!, true)).toBe(24 * 60);
    expect(rfqDeliveryDelayMinutes(pro!, true)).toBe(0);
    expect(rfqDeliveryDelayMinutes(pro!, false)).toBe(360);
    expect(rfqDeliveryDelayMinutes(free!, false)).toBe(24 * 60);
    expect(deliveryFor(pro!, true)).toBe("instant");
    expect(deliveryFor(pro!, false)).toBe("delayed");
    expect(deliveryFor(free!, true)).toBe("delayed");
  });
});
