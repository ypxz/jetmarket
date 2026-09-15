import { describe, expect, it } from "vitest";
import { jetsVertical, machineryVertical } from "@jetmarket/verticals";
import type { Listing } from "./repo/types";
import {
  listingSummary,
  resolveSeoPage,
  seoListingsQuery,
  seoSlugs,
} from "./seo";

describe("resolveSeoPage", () => {
  it("resolves a configured landing page slug", () => {
    const def = resolveSeoPage(jetsVertical, "empty-legs-zurich-nice");
    expect(def?.filters.type).toBe("empty_leg");
    expect(def?.filters.from).toBe("ZRH");
  });

  it("returns undefined for unknown slugs", () => {
    expect(resolveSeoPage(jetsVertical, "not-a-page")).toBeUndefined();
  });
});

describe("seoListingsQuery", () => {
  it("splits type out of attribute facets", () => {
    const def = resolveSeoPage(jetsVertical, "empty-legs-zurich-nice")!;
    const q = seoListingsQuery(def);
    expect(q.type).toBe("empty_leg");
    expect(q.facets).toEqual({ from: "ZRH", to: "NCE" });
  });
});

describe("seoSlugs", () => {
  it("exposes ≥10 landing pages per vertical", () => {
    expect(seoSlugs(jetsVertical).length).toBeGreaterThanOrEqual(10);
    expect(seoSlugs(machineryVertical).length).toBeGreaterThanOrEqual(10);
  });

  it("slugs are unique", () => {
    for (const v of [jetsVertical, machineryVertical]) {
      expect(new Set(seoSlugs(v)).size).toBe(seoSlugs(v).length);
    }
  });
});

describe("listingSummary", () => {
  const base: Listing = {
    id: "l1",
    operatorId: "op1",
    vertical: "jets",
    type: "empty_leg",
    title: "x",
    attributes: {},
    price: 1,
    currency: "USD",
    status: "active",
    photos: [],
    createdAt: "",
  };

  it("summarises a jets empty leg", () => {
    const s = listingSummary({
      ...base,
      attributes: {
        model: "Phenom 300",
        from: "ZRH",
        to: "NCE",
        seats: 7,
        year: 2021,
      },
    });
    expect(s).toContain("Phenom 300");
    expect(s).toContain("ZRH → NCE");
    expect(s).toContain("7 seats");
    expect(s).toContain("2021");
  });

  it("summarises a machinery listing", () => {
    const s = listingSummary({
      ...base,
      type: "for_sale" as Listing["type"],
      attributes: {
        make: "DMG Mori",
        machineryCategory: "cnc_milling",
        yearOfManufacture: 2019,
      },
    });
    expect(s).toContain("DMG Mori");
    expect(s).toContain("cnc milling");
    expect(s).toContain("2019");
  });
});
