import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  listingTypeDeclared,
  validateListingAttributes,
  validateNewListing,
} from "./listing";
import type { VerticalConfig } from "./vertical-config";

const ICAO = z.string().regex(/^[A-Z]{3,4}$/);

const jetsConfig: Pick<
  VerticalConfig,
  "listingTypes" | "attributes" | "currency"
> = {
  currency: "USD",
  listingTypes: [
    { slug: "charter", labelKey: "listingTypes.charter" },
    { slug: "empty_leg", labelKey: "listingTypes.empty_leg" },
    { slug: "aircraft_sale", labelKey: "listingTypes.aircraft_sale" },
  ],
  attributes: [
    {
      key: "aircraftCategory",
      labelKey: "attributes.aircraftCategory",
      appliesTo: ["charter", "empty_leg", "aircraft_sale"],
      schema: z.enum(["light", "midsize", "heavy", "ultra_long_range"]),
    },
    {
      key: "aircraftModel",
      labelKey: "attributes.aircraftModel",
      appliesTo: ["charter", "empty_leg", "aircraft_sale"],
      schema: z.string().min(1).max(80),
    },
    {
      key: "seats",
      labelKey: "attributes.seats",
      appliesTo: ["charter", "empty_leg", "aircraft_sale"],
      schema: z.number().int().min(1).max(30),
    },
    {
      key: "baseIcao",
      labelKey: "attributes.baseIcao",
      appliesTo: ["charter"],
      schema: ICAO,
    },
    {
      key: "departureIcao",
      labelKey: "attributes.departureIcao",
      appliesTo: ["empty_leg"],
      schema: ICAO,
    },
    {
      key: "arrivalIcao",
      labelKey: "attributes.arrivalIcao",
      appliesTo: ["empty_leg"],
      schema: ICAO,
    },
    {
      key: "departureDate",
      labelKey: "attributes.departureDate",
      appliesTo: ["empty_leg"],
      schema: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    },
  ],
};

describe("validateListingAttributes", () => {
  it("accepts valid charter attributes", () => {
    const r = validateListingAttributes(jetsConfig, "charter", {
      aircraftCategory: "light",
      aircraftModel: "Phenom 300",
      seats: 7,
      baseIcao: "ZRH",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.aircraftModel).toBe("Phenom 300");
  });

  it("reports attribute issues with paths", () => {
    const r = validateListingAttributes(jetsConfig, "charter", {
      aircraftCategory: "jumbo",
      aircraftModel: "X",
      seats: 7,
      baseIcao: "ZRH",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === "aircraftCategory")).toBe(true);
    }
  });

  it("fails when the listing type is not declared", () => {
    const r = validateListingAttributes(jetsConfig, "blimp", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe("type");
  });

  it("strips unknown attribute keys (config is the only contract)", () => {
    const r = validateListingAttributes(jetsConfig, "charter", {
      aircraftCategory: "light",
      aircraftModel: "Phenom 300",
      seats: 7,
      baseIcao: "ZRH",
      smuggled: "nope",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect("smuggled" in r.value).toBe(false);
  });
});

describe("validateNewListing", () => {
  it("normalizes a valid draft (defaults applied)", () => {
    const r = validateNewListing(jetsConfig, {
      type: "empty_leg",
      title: "ZRH → NCE empty leg",
      attributes: {
        aircraftCategory: "midsize",
        aircraftModel: "Citation XLS",
        seats: 8,
        departureIcao: "ZRH",
        arrivalIcao: "NCE",
        departureDate: "2026-10-01",
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.currency).toBe("USD");
      expect(r.value.status).toBe("draft");
      expect(r.value.photos).toEqual([]);
      expect(r.value.priceMinor).toBeNull();
    }
  });

  it("rejects undeclared listing types", () => {
    const r = validateNewListing(jetsConfig, {
      type: "helicopter",
      title: "A perfectly fine listing",
      attributes: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.path)).toContain("type");
    }
  });

  it("collects core + attribute issues together", () => {
    const r = validateNewListing(jetsConfig, {
      type: "charter",
      title: "ab", // too short
      attributes: { aircraftCategory: "jumbo" }, // bad enum + missing required
      photos: Array.from({ length: 31 }, (_, i) => `p${i}`), // too many
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.issues.map((i) => i.path);
      expect(paths).toContain("title");
      expect(paths).toContain("photos");
      expect(paths).toContain("aircraftCategory");
    }
  });
});

describe("listingTypeDeclared", () => {
  it("checks the slug", () => {
    expect(listingTypeDeclared(jetsConfig, "empty_leg")).toBe(true);
    expect(listingTypeDeclared(jetsConfig, "nope")).toBe(false);
  });
});
