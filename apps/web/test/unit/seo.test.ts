import { describe, expect, it } from "vitest";
import { getVertical } from "@jetmarket/verticals";
import {
  languageUrls,
  localeUrl,
  resolveSeoPage,
  searchHref,
  seoAlternates,
  seoSlugs,
  siteUrl,
} from "@/lib/seo";
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

// hreflang alternates (QA-497): every indexable page self-canonicals in its
// own locale and advertises the en/de pair + x-default so translated pages
// rank instead of collapsing onto the English URL.
describe("locale-aware alternates", () => {
  it("localeUrl prefixes only non-default locales", async () => {
    expect(localeUrl("en", "/listing/l1")).toBe(`${siteUrl()}/listing/l1`);
    expect(localeUrl("de", "/listing/l1")).toBe(
      `${siteUrl()}/de/listing/l1`,
    );
    expect(localeUrl("de", "/")).toBe(`${siteUrl()}/de`);
    expect(localeUrl("en", "/")).toBe(`${siteUrl()}/`);
  });

  it("languageUrls maps every locale plus x-default", async () => {
    const langs = languageUrls("/empty-legs-zurich-nice");
    expect(langs.en).toBe(`${siteUrl()}/empty-legs-zurich-nice`);
    expect(langs.de).toBe(`${siteUrl()}/de/empty-legs-zurich-nice`);
    expect(langs["x-default"]).toBe(langs.en);
  });

  it("seoAlternates self-canonicals in the page's locale", async () => {
    const de = seoAlternates("de", "/operators");
    expect(de?.canonical).toBe(`${siteUrl()}/de/operators`);
    const en = seoAlternates("en", "/operators");
    expect(en?.canonical).toBe(`${siteUrl()}/operators`);
    // Both emit the same language map.
    expect(de?.languages).toEqual(en?.languages);
  });
});
