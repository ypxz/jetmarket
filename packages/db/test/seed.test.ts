import { describe, expect, it } from "vitest";
import { jetsVertical } from "@jetmarket/verticals";
import { validateNewListing } from "@jetmarket/domain";
import { buildJetsSeed, JETS_SEED_COUNTS } from "../src/seed/jets";

const seed = buildJetsSeed(new Date("2026-09-15T00:00:00Z"));

describe("buildJetsSeed", () => {
  it("produces 15 users/operators and 60 listings", () => {
    expect(seed.userRows).toHaveLength(JETS_SEED_COUNTS.operators);
    expect(seed.opRows).toHaveLength(JETS_SEED_COUNTS.operators);
    expect(seed.listingRows).toHaveLength(JETS_SEED_COUNTS.listings);
  });

  it("uses deterministic unique ids per table", () => {
    for (const rows of [seed.userRows, seed.opRows, seed.listingRows]) {
      const ids = rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).toMatch(/^00000000-0000-4000-8000-\d{12}$/);
      }
    }
  });

  it("validates every listing against the real jets config", () => {
    for (const l of seed.listingRows) {
      const r = validateNewListing(jetsVertical, {
        type: l.type,
        title: l.title,
        attributes: l.attributes ?? {},
        priceMinor: l.priceMinor,
        currency: l.currency,
        status: l.status,
        photos: l.photos ?? [],
      });
      expect(r.ok, `${l.title}: ${r.ok ? "" : JSON.stringify(r.issues)}`).toBe(
        true,
      );
    }
  });

  it("covers empty legs on ZRH/GVA/NCE/LTN", () => {
    const legs = seed.listingRows.filter((l) => l.type === "empty_leg");
    const airports = new Set(
      legs.flatMap((l) => [
        String(l.attributes?.["from"]),
        String(l.attributes?.["to"]),
      ]),
    );
    for (const a of ["ZRH", "GVA", "NCE", "LTN"]) {
      expect(airports.has(a), `empty legs must touch ${a}`).toBe(true);
    }
    // All legs have future departure dates.
    for (const l of legs) {
      const d = String(l.attributes?.["date"]);
      expect(d >= "2026-09-15").toBe(true);
    }
  });

  it("has a realistic mix of types, plans and verification states", () => {
    const types = seed.listingRows.reduce<Record<string, number>>((m, l) => {
      m[l.type] = (m[l.type] ?? 0) + 1;
      return m;
    }, {});
    expect(types["charter"]).toBe(21);
    expect(types["empty_leg"]).toBe(27);
    expect(types["aircraft_sale"]).toBe(12);

    const verified = seed.opRows.filter((o) => o.verified).length;
    const pro = seed.opRows.filter((o) => o.plan === "pro").length;
    expect(verified).toBeGreaterThanOrEqual(8);
    expect(pro).toBe(5);
    // Every operator owns ≥1 listing.
    const byOp = new Map(seed.listingRows.map((l) => [l.operatorId, true]));
    for (const o of seed.opRows) expect(byOp.has(o.id!)).toBe(true);
  });
});
