import { describe, expect, it } from "vitest";
import { formatAttribute, formatAttributeDate, formatMoney } from "@/lib/format";

describe("formatAttributeDate (QA-216)", () => {
  it("renders ISO dates medium-style in UTC", () => {
    expect(formatAttributeDate("2026-10-01")).toBe("Oct 1, 2026");
  });

  it("falls back to the raw string for non-ISO input", () => {
    expect(formatAttributeDate("next Tuesday")).toBe("next Tuesday");
    expect(formatAttributeDate("2026-13-45")).toBe("2026-13-45");
    expect(formatAttributeDate("")).toBe("");
  });
});

describe("formatAttribute / formatMoney sanity", () => {
  it("never groups bare numbers (year stays 2020)", () => {
    expect(formatAttribute(2020)).toBe("2020");
  });
  it("groups unit-carrying numbers", () => {
    expect(formatAttribute(1450, "h")).toBe("1,450 h");
  });
  it("formats money without decimals", () => {
    expect(formatMoney(4200, "USD")).toBe("$4,200");
  });
});
