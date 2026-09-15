import { describe, expect, it } from "vitest";
import { successFeeAmount, successFeePctFor } from "./fees";
import type { VerticalConfig } from "./vertical-config";

const config: Pick<VerticalConfig, "fees"> = {
  fees: {
    subscriptionPlans: [],
    successFeePct: { charter: 3, empty_leg: 3, aircraft_sale: 1.5 },
  },
};

describe("fees", () => {
  it("reads the configured rate per listing type", () => {
    expect(successFeePctFor(config, "charter")).toBe(3);
    expect(successFeePctFor(config, "aircraft_sale")).toBe(1.5);
    expect(() => successFeePctFor(config, "helicopter")).toThrow(
      /no success fee/,
    );
  });

  it("computes fee amounts in minor units", () => {
    // $50k charter -> $1,500 fee
    expect(successFeeAmount(5_000_000, 3)).toBe(150_000);
    // $20M aircraft sale -> $300k fee
    expect(successFeeAmount(2_000_000_000, 1.5)).toBe(30_000_000);
  });

  it("rejects bad amounts", () => {
    expect(() => successFeeAmount(-5, 3)).toThrow();
    expect(() => successFeeAmount(Number.NaN, 3)).toThrow();
  });
});
