import { describe, expect, it } from "vitest";
import { getVertical } from "@jetmarket/verticals";
import { resolveSeoPage, searchHref, seoSlugs, siteUrl } from "@/lib/seo";
import { searchListings } from "@/lib/search";

const vertical = getVertical();

describe("seo landing pages (jets)", () => {
  it("ships at least 10 landing pages", async () => {
    expect(seoSlugs().length).toBeGreaterThanOrEqual(10);
  });

  it("resolves a known slug and misses unknown ones", async () => {
    expect(resolveSeoPage(vertical, "empty-legs-zurich-nice")?.slug).toBe(
      "empty-legs-zurich-nice",
    );
    expect(resolveSeoPage(vertical, "nope")).toBeUndefined();
  });

  it("every page's filters drive searchListings", async () => {
    for (const def of vertical.seo.landingPages) {
      // must not throw; facet keys in filters must exist in the config
      for (const key of Object.keys(def.filters)) {
        expect(
          vertical.facets.some((f) => f.key === key),
          `filter key ${key} on ${def.slug}`,
        ).toBe(true);
      }
      await searchListings(def.filters);
    }
  });

  it("ZRH→NCE page returns the seeded empty leg", async () => {
    const def = resolveSeoPage(vertical, "empty-legs-zurich-nice")!;
    const r = await searchListings(def.filters);
    expect(r.length).toBe(1);
    expect(r[0]?.attributes.from).toBe("ZRH");
  });

  it("searchHref carries the page's filters", async () => {
    const def = resolveSeoPage(vertical, "empty-legs-zurich-nice")!;
    expect(searchHref(def)).toBe(
      "/search?type=empty_leg&from=ZRH&to=NCE",
    );
  });

  it("siteUrl falls back to the configured domain", async () => {
    expect(siteUrl()).toMatch(/^https?:\/\//);
  });
});
