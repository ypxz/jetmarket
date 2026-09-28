import { describe, expect, it } from "vitest";
import {
  buildRfqSchema,
  contactFieldKeys,
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
      const scopes = [undefined, ...v.listingTypes.map((t) => t.slug)];
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

describe("contactFieldKeys (QA-308)", () => {
  it("covers email/tel types AND the contact group for every vertical", () => {
    for (const v of [jetsVertical, machineryVertical]) {
      const keys = contactFieldKeys(v);
      expect(keys.has("name")).toBe(true); // contact-grouped
      expect(keys.has("email")).toBe(true); // email-typed
      expect(keys.has("phone")).toBe(true); // tel-typed
      expect(keys.has("notes")).toBe(false);
      // every email/tel field is masked even if its groupKey was forgotten
      for (const f of v.rfqFields) {
        if (f.type === "email" || f.type === "tel") {
          expect(keys.has(f.key)).toBe(true);
        }
      }
    }
  });
});

// QA-282: a third vertical is meant to be "config + content" — these checks
// catch a config that boots but fails later at render/search/fan-out time.
describe("config integrity (every registered vertical)", () => {
  const verticals = [jetsVertical, machineryVertical];

  for (const v of verticals) {
    describe(v.slug, () => {
      it("fees.successFeePct covers every listing type and nothing else", () => {
        const types = v.listingTypes.map((t) => t.slug).sort();
        expect(Object.keys(v.fees.successFeePct).sort()).toEqual(types);
      });

      it("facets resolve to real attributes with compatible types", () => {
        const attrByKey = new Map(v.attributes.map((a) => [a.key, a]));
        const types = new Set(v.listingTypes.map((t) => t.slug));
        for (const f of v.facets) {
          if (!f.attributeKey) {
            // Built-in facets filter typed Listing fields (see FacetConfig):
            // `type` and `price`; anything else needs an attributeKey.
            expect(["type", "price"]).toContain(f.key);
            continue;
          }
          const attr = attrByKey.get(f.attributeKey);
          expect(
            attr,
            `facet ${f.key} -> missing attribute ${f.attributeKey}`,
          ).toBeDefined();
          if (f.type === "enum") {
            const enumValues =
              (attr!.schema as unknown as { options?: string[] }).options ?? [];
            for (const o of f.options ?? []) {
              expect(
                enumValues,
                `facet ${f.key} option ${o.value} not in attribute enum`,
              ).toContain(o.value);
            }
          }
          if (f.type === "date-range") {
            expect(attr!.inputType ?? "date").toBe("date");
          }
        }
        // `type` facet values (if declared as options) must be listing types
        const typeFacet = v.facets.find((f) => f.key === "type");
        for (const o of typeFacet?.options ?? []) {
          expect(types.has(o.value)).toBe(true);
        }
      });

      it("expiry points at a declared date attribute on a real type", () => {
        if (!v.expiry) return;
        const types = v.listingTypes.map((t) => t.slug);
        expect(types).toContain(v.expiry.type);
        const attr = v.attributes.find((a) => a.key === v.expiry!.attributeKey);
        expect(attr, "expiry attributeKey not in attributes").toBeDefined();
        expect(attr!.appliesTo).toContain(v.expiry.type);
        expect(attr!.inputType ?? "date").toBe("date");
        expect(attr!.schema.safeParse("2030-01-01").success).toBe(true);
      });

      it("seo landing pages have unique slugs and resolvable facet filters", () => {
        const slugs = v.seo.landingPages.map((p) => p.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
        const facetKeys = new Set([
          ...v.facets.map((f) => f.key),
          "q",
          "sort",
          "page",
        ]);
        for (const p of v.seo.landingPages) {
          for (const k of Object.keys(p.filters)) {
            expect(
              facetKeys.has(k),
              `seo page ${p.slug} filters on unknown facet ${k}`,
            ).toBe(true);
          }
        }
      });

      it("declares exactly one free and one pro plan", () => {
        const plans = v.fees.subscriptionPlans;
        const free = plans.filter((p) => p.slug === "free");
        const pro = plans.filter((p) => p.slug === "pro");
        expect(free).toHaveLength(1);
        expect(pro).toHaveLength(1);
        expect(free[0]!.monthlyPriceUsd).toBe(0);
        expect(Number.isInteger(free[0]!.maxListings)).toBe(true);
        expect(pro[0]!.monthlyPriceUsd).toBeGreaterThan(0);
        expect(pro[0]!.maxListings).toBeNull();
      });

      it("matching-config attribute refs resolve to declared attributes", () => {
        const attrKeys = new Set(v.attributes.map((a) => a.key));
        const m = v.matching;
        if (!m) return;
        if (m.categoryAttribute) expect(attrKeys.has(m.categoryAttribute)).toBe(true);
        if (m.seatsAttribute) expect(attrKeys.has(m.seatsAttribute)).toBe(true);
        if (m.fleetListingType) {
          expect(v.listingTypes.map((t) => t.slug)).toContain(m.fleetListingType);
        }
      });
    });
  }
});
