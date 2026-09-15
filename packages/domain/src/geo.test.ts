import { describe, expect, it } from "vitest";
import { OTHER_REGION, regionOfAirport, sameRegion } from "./geo";

describe("geo", () => {
  it("resolves seed airports to regions", () => {
    expect(regionOfAirport("ZRH")).toBe("CH");
    expect(regionOfAirport("GVA")).toBe("CH");
    expect(regionOfAirport("NCE")).toBe("FR");
    expect(regionOfAirport("LTN")).toBe("GB");
    expect(regionOfAirport("TEB")).toBe("US-E");
  });

  it("is case-insensitive and handles missing codes", () => {
    expect(regionOfAirport("zrh")).toBe("CH");
    expect(regionOfAirport(null)).toBe(OTHER_REGION);
    expect(regionOfAirport("")).toBe(OTHER_REGION);
    expect(regionOfAirport("XXXX")).toBe(OTHER_REGION);
  });

  it("compares regions safely", () => {
    expect(sameRegion("ZRH", "GVA")).toBe(true);
    expect(sameRegion("ZRH", "LTN")).toBe(false);
    expect(sameRegion("ZRH", "XXXX")).toBe(false);
    expect(sameRegion(null, "LTN")).toBe(false);
    expect(sameRegion("XXXX", "YYYY")).toBe(false); // both unknown != same
  });

  it("supports map overrides", () => {
    expect(regionOfAirport("AAA", { AAA: "X" })).toBe("X");
    expect(sameRegion("AAA", "BBB", { AAA: "X", BBB: "X" })).toBe(true);
  });
});
