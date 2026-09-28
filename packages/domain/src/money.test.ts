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

  it("holds the fee invariants over representative inputs", () => {
    // Business invariant: a success fee can never exceed the deal amount,
    // and rounding only ever nudges ±1 minor unit from the exact product.
    const minors = [0, 1, 2, 99, 100, 101, 999, 10_000, 123_457, 1_000_000];
    const pcts = [0, 0.5, 1, 3, 12.5, 50, 99.9, 100];
    for (const m of minors) {
      for (const p of pcts) {
        const fee = percentOf(m, p);
        expect(fee).toBeGreaterThanOrEqual(0);
        expect(fee).toBeLessThanOrEqual(m); // pct<=100 ⇒ fee<=amount
        // exact = m*p/100; |fee − exact| <= 0.5 minor unit (half-up round).
        expect(Math.abs(fee - (m * p) / 100)).toBeLessThanOrEqual(0.5);
      }
    }
    // minor-unit round-trip is lossless — a 0-digit currency only gets
    // whole-number majors (99.99 JPY legitimately rounds to 100).
    for (const cur of ["USD", "JPY"] as const) {
      const majors =
        minorUnitDigits(cur) === 0
          ? [0, 1, 199, 12346]
          : [0, 1, 199, 99.99, 12345.67];
      for (const major of majors) {
        expect(fromMinorUnits(toMinorUnits(major, cur), cur)).toBeCloseTo(
          major,
          2,
        );
      }
    }
  });
});
