import { describe, expect, it } from "vitest";
import { paginate, SEARCH_PAGE_SIZE, searchListings } from "@/lib/search";

// Runs against the seeded in-memory repo (lib/repo/memory.ts).
describe("searchListings (config-driven, jets)", () => {
  it("returns all active listings with no params", async () => {
    expect((await searchListings({})).length).toBe(8);
  });

  it("filters by listing type facet", async () => {
    const r = await searchListings({ type: "empty_leg" });
    expect(r.length).toBe(4);
    expect(r.every((l) => l.type === "empty_leg")).toBe(true);
  });

  it("free-text query matches title/attributes", async () => {
    const r = await searchListings({ q: "G650" });
    expect(r.length).toBe(1);
    expect(r[0]?.type).toBe("aircraft_sale");
  });

  it("enum facet on attributes.aircraftCategory", async () => {
    const r = await searchListings({ aircraftCategory: "light" });
    expect(r.length).toBe(2);
    expect(r.every((l) => l.attributes.aircraftCategory === "light")).toBe(true);
  });

  it("text facet normalizes airport codes to uppercase", async () => {
    const r = await searchListings({ type: "empty_leg", from: "zrh" });
    expect(r.length).toBe(1);
    expect(r[0]?.attributes.from).toBe("ZRH");
  });

  it("number-range facet on top-level price", async () => {
    const r = await searchListings({ priceMax: "5000" });
    expect(r.length).toBe(1);
    expect(r[0]?.price).toBe(4200);
  });

  it("number-range facet on attributes.seats", async () => {
    const r = await searchListings({ seatsMin: "9" });
    expect(r.length).toBe(4);
    expect(r.every((l) => Number(l.attributes.seats) >= 9)).toBe(true);
  });

  it("date-range facet on attributes.date (legDate) — strict bounds", async () => {
    // Memory seed keys leg dates to today+N (inDays 1/2/3/6).
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const plus1 = new Date(Date.now() + 86_400_000);
    const plus2 = new Date(Date.now() + 2 * 86_400_000);

    const one = await searchListings({
      type: "empty_leg",
      legDateFrom: iso(today),
      legDateTo: iso(plus1),
    });
    expect(one.length).toBe(1);
    expect(one[0]?.attributes.to).toBe("GVA");

    const two = await searchListings({ legDateTo: iso(plus2) });
    // Strict: listings without a `date` attribute never match a set bound —
    // only the two earliest empty legs qualify.
    expect(two.length).toBe(2);
    expect(two.every((l) => l.type === "empty_leg")).toBe(true);
  });

  it("date-range ignores non-ISO params", async () => {
    const r = await searchListings({
      type: "empty_leg",
      legDateFrom: "garbage",
      legDateTo: "20/10/2026",
    });
    expect(r.length).toBe(4);
  });

  it("combines query + facets + ranges", async () => {
    const r = await searchListings({
      type: "empty_leg",
      aircraftCategory: "light",
      priceMax: "7000",
    });
    expect(r.length).toBe(2);
  });

  it("unknown params are ignored", async () => {
    expect((await searchListings({ nonsense: "x" })).length).toBe(8);
  });

  it("sorts by price asc/desc; unknown sort falls back to newest", async () => {
    const asc = (await searchListings({ sort: "price_asc" })).map((l) => l.price);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    const desc = (await searchListings({ sort: "price_desc" })).map((l) => l.price);
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    // QA-178: bogus values degrade to the default order, not an error.
    const bogus = (await searchListings({ sort: "nonsense" })).map((l) => l.id);
    const dflt = (await searchListings({})).map((l) => l.id);
    expect(bogus).toEqual(dflt);
  });
});

describe("paginate", () => {
  const many = Array.from({ length: SEARCH_PAGE_SIZE * 2 + 3 }, (_, i) => i);

  it("slices page 1 and reports totals", () => {
    const p = paginate(many, undefined);
    expect(p.items).toEqual(many.slice(0, SEARCH_PAGE_SIZE));
    expect(p).toMatchObject({ page: 1, pages: 3, total: many.length });
  });

  it("serves a middle page", () => {
    const p = paginate(many, "2");
    expect(p.page).toBe(2);
    expect(p.items).toEqual(many.slice(SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE * 2));
  });

  it("clamps out-of-range and invalid input to valid pages", () => {
    expect(paginate(many, "99").page).toBe(3);
    expect(paginate(many, "0").page).toBe(1);
    expect(paginate(many, "-2").page).toBe(1);
    expect(paginate(many, "abc").page).toBe(1);
    expect(paginate(many, "1.5").page).toBe(1);
  });

  it("handles the empty and exact-boundary cases", () => {
    expect(paginate([], "3")).toMatchObject({ items: [], page: 1, pages: 1, total: 0 });
    const exact = Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => i);
    expect(paginate(exact, "2").page).toBe(1);
  });
});

/**
 * QA-143 — GET /api/listings must whitelist facets to the active vertical's
 * declared set. The old `f_*` passthrough let scrapers probe arbitrary
 * attributes-jsonb paths (unbounded count, unindexed keys).
 */
import { GET as listListings } from "../../app/api/listings/route";

describe("GET /api/listings facet whitelist (QA-143)", () => {
  it("ignores undeclared facet keys; declared ones still filter", async () => {
    // A bogus key alone must NOT narrow the result — 8 seeded jets listings.
    const bogus = await listListings(
      new Request("http://test.local/api/listings?f_sequel=anything&password=hunter2"),
    );
    expect(bogus.status).toBe(200);
    const all = (await bogus.json()) as unknown[];
    expect(all.length).toBe(8);

    // Declared facet key filters as before.
    const filtered = await listListings(
      new Request("http://test.local/api/listings?aircraftCategory=light"),
    );
    const lights = (await filtered.json()) as {
      attributes: Record<string, unknown>;
    }[];
    expect(lights.length).toBe(2);
    expect(lights.every((l) => l.attributes.aircraftCategory === "light")).toBe(
      true,
    );
  });
});
