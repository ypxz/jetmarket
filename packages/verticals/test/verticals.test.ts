import { describe, expect, it } from "vitest";
import {
  buildRfqSchema,
  getAttributesSchema,
  getVertical,
  getVerticalSlug,
  isVerticalSlug,
  jetsVertical,
  machineryVertical,
  nonContactFields,
  rfqFieldsFor,
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
      expect(page.filters.type).toBe("empty_leg");
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

  it("each listing-type scope has exactly one email-typed RFQ field", () => {
    // RfqForm derives the buyer-contact field as the single email-typed
    // field in scope (QA-246) — a vertical with zero or two would break
    // buyer inbox access.
    for (const v of [jetsVertical, machineryVertical]) {
      const scopes = [undefined, ...v.listingTypes.map((t) => t.key)];
      for (const scope of scopes) {
        const emails = rfqFieldsFor(v, scope).filter((f) => f.type === "email");
        expect(
          emails,
          `${v.slug}/${scope ?? "all"} should declare one email field`,
        ).toHaveLength(1);
      }
    }
  });
});

describe("getAttributesSchema (jets)", () => {
  it("validates a well-formed empty_leg listing", () => {
    const schema = getAttributesSchema(jetsVertical, "empty_leg");
    const parsed = schema.parse({
      aircraftCategory: "light",
      model: "Phenom 300",
      year: 2019,
      seats: 7,
      rangeNm: 2000,
      from: "zrh",
      to: "NCE",
      date: "2026-10-01",
    });
    expect(parsed.from).toBe("ZRH");
  });

  it("rejects an unknown aircraft category and strips undeclared keys", () => {
    const schema = getAttributesSchema(jetsVertical, "empty_leg");
    expect(() =>
      schema.parse({
        aircraftCategory: "turboprop",
        model: "PC-12",
        year: 2020,
        seats: 8,
        rangeNm: 800,
        from: "ZRH",
        to: "GVA",
        date: "2026-10-01",
      }),
    ).toThrow();
    const parsed = schema.parse({
      aircraftCategory: "light",
      model: "Phenom 300",
      year: 2019,
      seats: 7,
      rangeNm: 2000,
      from: "ZRH",
      to: "NCE",
      date: "2026-10-01",
      smuggledKey: "nope",
    });
    expect("smuggledKey" in parsed).toBe(false);
  });

  it("empty_leg schema does not include charter-only attributes", () => {
    const schema = getAttributesSchema(jetsVertical, "empty_leg");
    expect("baseAirport" in schema.shape).toBe(false);
    expect("from" in schema.shape).toBe(true);
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

  it("scopes required fields by listing type (QA-147)", () => {
    // An aircraft-sale inquiry has no trip: dateFrom/To, pax, route are
    // absent from the schema — contact + optional budget only.
    const sale = buildRfqSchema(jetsVertical, "aircraft_sale");
    expect(() =>
      sale.parse({ name: "Ada Buyer", email: "ada@example.com" }),
    ).not.toThrow();
    expect(() =>
      sale.parse({ name: "Ada Buyer", email: "ada@example.com", departure: "ZRH" }),
    ).not.toThrow(); // extra keys stripped, never required
    // Charter still requires the trip fields.
    expect(() =>
      buildRfqSchema(jetsVertical, "charter").parse({
        name: "Ada",
        email: "a@b.c",
      }),
    ).toThrow();
    // No listing type → unchanged (all fields).
    expect(() => buildRfqSchema(jetsVertical).parse({
      name: "Ada", email: "a@b.c",
    })).toThrow();
  });

  it("rejects impossible calendar dates and reversed date windows (QA-197)", () => {
    const schema = buildRfqSchema(jetsVertical, "charter");
    // ISO shape but not a real calendar date
    expect(() =>
      schema.parse({ ...valid, dateFrom: "2026-13-40" }),
    ).toThrow();
    // and a window that ends before it starts
    expect(() =>
      schema.parse({ ...valid, dateFrom: "2026-10-12", dateTo: "2026-10-10" }),
    ).toThrow();
    // equal bounds are a valid single-day window
    expect(() =>
      schema.parse({ ...valid, dateFrom: "2026-10-10", dateTo: "2026-10-10" }),
    ).not.toThrow();
  });

  it("listing date attributes use the same real-calendar rule (QA-197)", () => {
    const schema = getAttributesSchema(jetsVertical, "empty_leg");
    const good = {
      aircraftCategory: "light",
      model: "Phenom 300",
      seats: 7,
      year: 2020,
      rangeNm: 2000,
      from: "zrh",
      to: "NCE",
      date: "2026-10-10",
    };
    expect(() => schema.parse(good)).not.toThrow();
    expect(() => schema.parse({ ...good, date: "2026-02-30" })).toThrow();
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
    });
    expect(parsed.machineryCategory).toBe("cnc_milling");
  });
});

describe("nonContactFields (QA-152)", () => {
  it("strips email/tel-typed keys, keeps the rest", () => {
    const out = nonContactFields(jetsVertical, "charter", {
      name: "Ada",
      email: "a@b.c",
      phone: "+41 79",
      departure: "ZRH",
      passengers: 2,
    });
    expect(out).toEqual({ name: "Ada", departure: "ZRH", passengers: 2 });
  });

  it("scopes hidden keys to the listing type", () => {
    // machinery dates apply only to for_rent; contact fields are hidden
    // regardless of type.
    const out = nonContactFields(machineryVertical, "for_sale", {
      name: "Ada",
      email: "a@b.c",
      make: "DMG MORI",
    });
    expect(out).toEqual({ name: "Ada", make: "DMG MORI" });
  });
});
