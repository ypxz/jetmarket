import { describe, expect, it } from "vitest";
import {
  fromMinorUnits,
  minorUnitDigits,
  percentOf,
  toMinorUnits,
} from "./money";

describe("money", () => {
  it("knows minor unit digits", () => {
    expect(minorUnitDigits("USD")).toBe(2);
    expect(minorUnitDigits("JPY")).toBe(0);
    expect(minorUnitDigits("XXX")).toBe(2);
  });

  it("converts to/from minor units", () => {
    expect(toMinorUnits(199, "USD")).toBe(19_900);
    expect(toMinorUnits(199.99, "USD")).toBe(19_999);
    expect(toMinorUnits(0.005, "USD")).toBe(1); // half-up
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(fromMinorUnits(19_900, "USD")).toBe(199);
    expect(fromMinorUnits(1500, "JPY")).toBe(1500);
  });

  it("computes percentages without float error", () => {
    expect(percentOf(10_000, 3)).toBe(300);
    expect(percentOf(1_000_000, 1.5)).toBe(15_000); // $10k sale -> $150 fee
    expect(percentOf(123_456, 3)).toBe(3704); // 3703.68 rounds half-up
    expect(percentOf(0, 3)).toBe(0);
  });
});
