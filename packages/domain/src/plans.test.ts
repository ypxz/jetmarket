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
  const [free, pro] = defaultPlans("USD");

  it("ships a generic free/pro pair matching the spec", () => {
    expect(free).toMatchObject({
      id: FREE_PLAN_ID,
      maxListings: 3,
      rfqDelayMinutes: 360,
      priceMinor: 0,
    });
    expect(pro).toMatchObject({
      id: PRO_PLAN_ID,
      maxListings: null,
      rfqDelayMinutes: 0,
      priceMinor: 19_900,
    });
  });

  it("looks plans up by id", () => {
    expect(planById(defaultPlans(), "pro")?.name).toBe("Pro");
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
    expect(rfqDeliveryDelayMinutes(free!, true)).toBe(360);
    expect(rfqDeliveryDelayMinutes(pro!, true)).toBe(0);
    expect(rfqDeliveryDelayMinutes(pro!, false)).toBe(360);
    expect(rfqDeliveryDelayMinutes(free!, false)).toBe(360);
    expect(deliveryFor(pro!, true)).toBe("instant");
    expect(deliveryFor(pro!, false)).toBe("delayed");
    expect(deliveryFor(free!, true)).toBe("delayed");
  });
});
