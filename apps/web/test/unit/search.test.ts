import { describe, expect, it } from "vitest";
import { searchListings } from "@/lib/search";

// Runs against the seeded in-memory repo (lib/repo/memory.ts).
describe("searchListings (config-driven, jets)", () => {
  it("returns all active listings with no params", () => {
    expect(searchListings({}).length).toBe(8);
  });

  it("filters by listing type facet", () => {
    const r = searchListings({ type: "empty_leg" });
    expect(r.length).toBe(4);
    expect(r.every((l) => l.type === "empty_leg")).toBe(true);
  });

  it("free-text query matches title/attributes", () => {
    const r = searchListings({ q: "G650" });
    expect(r.length).toBe(1);
    expect(r[0]?.type).toBe("aircraft_sale");
  });

  it("enum facet on attributes.aircraftCategory", () => {
    const r = searchListings({ aircraftCategory: "light" });
    expect(r.length).toBe(2);
    expect(r.every((l) => l.attributes.aircraftCategory === "light")).toBe(true);
  });

  it("text facet normalizes airport codes to uppercase", () => {
    const r = searchListings({ type: "empty_leg", from: "zrh" });
    expect(r.length).toBe(1);
    expect(r[0]?.attributes.from).toBe("ZRH");
  });

  it("number-range facet on top-level price", () => {
    const r = searchListings({ priceMax: "5000" });
    expect(r.length).toBe(1);
    expect(r[0]?.price).toBe(4200);
  });

  it("number-range facet on attributes.seats", () => {
    const r = searchListings({ seatsMin: "9" });
    expect(r.length).toBe(4);
    expect(r.every((l) => Number(l.attributes.seats) >= 9)).toBe(true);
  });

  it("combines query + facets + ranges", () => {
    const r = searchListings({
      type: "empty_leg",
      aircraftCategory: "light",
      priceMax: "7000",
    });
    expect(r.length).toBe(2);
  });

  it("unknown params are ignored", () => {
    expect(searchListings({ nonsense: "x" }).length).toBe(8);
  });
});
