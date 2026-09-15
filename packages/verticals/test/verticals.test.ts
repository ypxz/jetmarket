import { describe, expect, it } from "vitest";
import {
  buildRfqSchema,
  getAttributesSchema,
  getVertical,
  getVerticalSlug,
  isVerticalSlug,
  jetsVertical,
  machineryVertical,
} from "../src";

describe("getVertical / getVerticalSlug", () => {
  it("defaults to jets when VERTICAL is unset", () => {
    expect(getVerticalSlug(undefined)).toBe("jets");
    expect(getVertical().slug).toBe("jets");
  });

  it("loads machinery by slug", () => {
    expect(getVertical("machinery").slug).toBe("machinery");
  });

  it("rejects unknown slugs", () => {
    expect(() => getVertical("helicopters")).toThrow(/Unknown VERTICAL/);
    expect(isVerticalSlug("helicopters")).toBe(false);
  });
});

describe("VerticalConfig contract (jets)", () => {
  it("declares the three spec listing types", () => {
    expect(jetsVertical.listingTypes.map((t) => t.slug)).toEqual([
      "charter",
      "empty_leg",
      "aircraft_sale",
    ]);
  });

  it("successFeePct covers every listing type (3% / 1.5% per spec)", () => {
    for (const t of jetsVertical.listingTypes) {
      expect(jetsVertical.fees.successFeePct[t.slug]).toBeTypeOf("number");
    }
    expect(jetsVertical.fees.successFeePct.charter).toBe(3);
    expect(jetsVertical.fees.successFeePct.empty_leg).toBe(3);
    expect(jetsVertical.fees.successFeePct.aircraft_sale).toBe(1.5);
  });

  it("free plan allows 3 listings, pro is $199/mo unlimited", () => {
    const [free, pro] = jetsVertical.fees.subscriptionPlans;
    expect(free?.monthlyPriceUsd).toBe(0);
    expect(free?.maxListings).toBe(3);
    expect(pro?.monthlyPriceUsd).toBe(199);
    expect(pro?.maxListings).toBeNull();
  });

  it("has ≥10 SEO landing pages, all pre-filtered to empty legs", () => {
    expect(jetsVertical.seo.landingPages.length).toBeGreaterThanOrEqual(10);
    for (const page of jetsVertical.seo.landingPages) {
      expect(page.slug).toMatch(/^empty-legs-/);
      expect(page.filters.listingType).toBe("empty_leg");
    }
  });

  it("every facet option labelKey and field key is non-empty", () => {
    for (const f of jetsVertical.facets) {
      expect(f.key).toBeTruthy();
      expect(f.labelKey).toBeTruthy();
      for (const o of f.options ?? []) {
        expect(o.value).toBeTruthy();
        expect(o.labelKey).toBeTruthy();
      }
    }
  });
});

describe("getAttributesSchema (jets)", () => {
  it("validates a well-formed empty_leg listing", () => {
    const schema = getAttributesSchema(jetsVertical, "empty_leg");
    const parsed = schema.parse({
      aircraftCategory: "light",
      aircraftModel: "Phenom 300",
      yearOfManufacture: 2019,
      seats: 7,
      departureIcao: "ZRH",
      arrivalIcao: "NCE",
      departureDate: "2026-10-01",
      priceUsd: 9500,
    });
    expect(parsed.departureIcao).toBe("ZRH");
  });

  it("rejects an unknown aircraft category and strips undeclared keys", () => {
    const schema = getAttributesSchema(jetsVertical, "empty_leg");
    expect(() =>
      schema.parse({
        aircraftCategory: "turboprop",
        aircraftModel: "PC-12",
        yearOfManufacture: 2020,
        seats: 8,
        departureIcao: "ZRH",
        arrivalIcao: "GVA",
        departureDate: "2026-10-01",
        priceUsd: 4000,
      }),
    ).toThrow();
    const parsed = schema.parse({
      aircraftCategory: "light",
      aircraftModel: "Phenom 300",
      yearOfManufacture: 2019,
      seats: 7,
      departureIcao: "ZRH",
      arrivalIcao: "NCE",
      departureDate: "2026-10-01",
      priceUsd: 9500,
      smuggledKey: "nope",
    });
    expect("smuggledKey" in parsed).toBe(false);
  });

  it("empty_leg schema does not include charter-only attributes", () => {
    const schema = getAttributesSchema(jetsVertical, "empty_leg");
    expect("baseIcao" in schema.shape).toBe(false);
    expect("departureIcao" in schema.shape).toBe(true);
  });
});

describe("buildRfqSchema (jets)", () => {
  const valid = {
    departure: "Zurich",
    arrival: "Nice",
    dateFrom: "2026-10-10",
    dateTo: "2026-10-12",
    passengers: "4",
    budgetUsd: "",
    name: "Ada Buyer",
    email: "ada@example.com",
    phone: "",
    notes: "",
  };

  it("accepts a valid payload, coerces numbers, and treats '' optional fields as absent", () => {
    const parsed = buildRfqSchema(jetsVertical).parse(valid);
    expect(parsed.passengers).toBe(4);
    expect(parsed.budgetUsd).toBeUndefined();
    expect(parsed.email).toBe("ada@example.com");
  });

  it("rejects invalid email, out-of-range pax, and missing required fields", () => {
    const schema = buildRfqSchema(jetsVertical);
    expect(() => schema.parse({ ...valid, email: "not-an-email" })).toThrow();
    expect(() => schema.parse({ ...valid, passengers: "0" })).toThrow();
    expect(() => schema.parse({ ...valid, departure: "" })).toThrow();
  });
});

describe("machinery scaffold", () => {
  it("satisfies the same contract with a placeholder taxonomy", () => {
    expect(machineryVertical.slug).toBe("machinery");
    expect(machineryVertical.listingTypes.length).toBeGreaterThan(0);
    expect(machineryVertical.currency).toBe("EUR");
    for (const t of machineryVertical.listingTypes) {
      expect(machineryVertical.fees.successFeePct[t.slug]).toBeTypeOf("number");
    }
    expect(machineryVertical.attributes.length).toBeGreaterThan(0);
    expect(machineryVertical.rfqFields.length).toBeGreaterThan(0);
  });

  it("its attribute schema validates a sample listing", () => {
    const schema = getAttributesSchema(machineryVertical, "for_sale");
    const parsed = schema.parse({
      machineryCategory: "cnc_milling",
      make: "DMG MORI",
      yearOfManufacture: 2015,
      locationCountry: "DE",
      priceEur: 85000,
    });
    expect(parsed.machineryCategory).toBe("cnc_milling");
  });
});
