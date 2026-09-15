import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  attributeSchemaFor,
  validateListingAttributes,
  validateNewListing,
} from "./listing";
import type { VerticalConfig } from "./vertical-config";

const jetsConfig: Pick<
  VerticalConfig,
  "listingTypes" | "attributes" | "currency"
> = {
  currency: "USD",
  listingTypes: ["charter", "empty_leg", "aircraft_sale"],
  attributes: [
    {
      listingType: "charter",
      schema: z.object({
        category: z.enum(["light", "mid", "heavy", "ultra-long"]),
        seats: z.number().int().positive(),
        model: z.string().min(1),
        year: z.number().int().min(1950),
        rangeNm: z.number().positive().optional(),
      }),
    },
    {
      listingType: "empty_leg",
      schema: z.object({
        departure: z.string().length(3),
        arrival: z.string().length(3),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        seats: z.number().int().positive(),
      }),
    },
    {
      listingType: "aircraft_sale",
      schema: z.object({
        model: z.string().min(1),
        year: z.number().int().min(1950),
        totalTimeHours: z.number().nonnegative(),
      }),
    },
  ],
};

describe("validateListingAttributes", () => {
  it("accepts valid charter attributes", () => {
    const r = validateListingAttributes(jetsConfig, "charter", {
      category: "light",
      seats: 7,
      model: "Phenom 300",
      year: 2019,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.model).toBe("Phenom 300");
  });

  it("reports attribute issues with paths", () => {
    const r = validateListingAttributes(jetsConfig, "charter", {
      category: "jumbo",
      seats: 7,
      model: "X",
      year: 2019,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === "category")).toBe(true);
    }
  });

  it("fails when the listing type has no schema", () => {
    const r = validateListingAttributes(jetsConfig, "blimp", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe("type");
  });
});

describe("validateNewListing", () => {
  it("normalizes a valid draft (defaults applied)", () => {
    const r = validateNewListing(jetsConfig, {
      type: "empty_leg",
      title: "ZRH → NCE empty leg",
      attributes: { departure: "ZRH", arrival: "NCE", date: "2026-10-01", seats: 8 },
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
      attributes: { category: "jumbo" }, // missing fields + bad enum
      photos: Array.from({ length: 31 }, (_, i) => `p${i}`), // too many
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.issues.map((i) => i.path);
      expect(paths).toContain("title");
      expect(paths).toContain("photos");
      expect(paths).toContain("category");
    }
  });
});

describe("attributeSchemaFor", () => {
  it("finds the schema for a type", () => {
    expect(attributeSchemaFor(jetsConfig, "empty_leg")?.listingType).toBe(
      "empty_leg",
    );
    expect(attributeSchemaFor(jetsConfig, "nope")).toBeUndefined();
  });
});
