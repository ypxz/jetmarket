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
    // All legs have future departure dates except the seeded flown leg
    // (GVA → IBZ, dayOffset -2 — QA-219 exercises public expiry).
    const past = legs.filter(
      (l) => String(l.attributes?.["date"]) < "2026-09-15",
    );
    expect(past.map((l) => l.attributes?.["to"])).toEqual(["IBZ"]);
    expect(legs.length - past.length).toBe(27);
  });

  it("has a realistic mix of types, plans and verification states", () => {
    const types = seed.listingRows.reduce<Record<string, number>>((m, l) => {
      m[l.type] = (m[l.type] ?? 0) + 1;
      return m;
    }, {});
    expect(types["charter"]).toBe(21);
    expect(types["empty_leg"]).toBe(28);
    expect(types["aircraft_sale"]).toBe(12);

    const verified = seed.opRows.filter((o) => o.verified).length;
    const pro = seed.opRows.filter((o) => o.plan === "pro").length;
    expect(verified).toBeGreaterThanOrEqual(8);
    expect(pro).toBe(5);
    // Every operator owns ≥1 listing.
    const byOp = new Map(seed.listingRows.map((l) => [l.operatorId, true]));
    for (const o of seed.opRows) expect(byOp.has(o.id!)).toBe(true);
  });

  it("seeds a demo RFQ trail: delivered to pro, delayed for free ops", () => {
    expect(seed.rfqRows).toHaveLength(1);
    const byState = seed.rfqMatchRows.reduce<Record<string, number>>(
      (m, r) => {
        m[r.state!] = (m[r.state!] ?? 0) + 1;
        return m;
      },
      {},
    );
    expect(byState["sent"]).toBe(1); // geneva-executive, delivered instantly
    expect(byState["delayed"]).toBe(2); // swiss-aircharter + helvetic (free)
  });

  it("seeds a live quote + known buyer token so the inbox demo works (QA-236)", () => {
    expect(seed.quoteRows).toHaveLength(1);
    const q = seed.quoteRows[0]!;
    expect(q.status).toBe("sent");
    expect(q.rfqId).toBe(seed.rfqRows[0]!.id);
    // The quoting operator is the delivered match — not a delayed free op.
    const delivered = seed.rfqMatchRows.find((m) => m.state === "sent")!;
    expect(q.operatorId).toBe(delivered.operatorId);
    expect(seed.rfqRows[0]!.status).toBe("quoted");
    expect(seed.rfqRows[0]!.accessToken).toBe("demo-buyer-token");
  });
});

import { machineryVertical } from "@jetmarket/verticals";
import { buildMachinerySeed, MACHINERY_SEED_COUNTS } from "../src/seed/machinery";

describe("buildMachinerySeed", () => {
  const mseed = buildMachinerySeed();

  it("produces 8 dealers and 17 listings", () => {
    expect(mseed.userRows).toHaveLength(MACHINERY_SEED_COUNTS.operators);
    expect(mseed.opRows).toHaveLength(MACHINERY_SEED_COUNTS.operators);
    expect(mseed.listingRows).toHaveLength(MACHINERY_SEED_COUNTS.listings);
  });

  it("ids do not collide with the jets seed counter space", () => {
    const jetsIds = new Set(
      [
        ...seed.userRows,
        ...seed.opRows,
        ...seed.listingRows,
        ...seed.rfqRows,
        ...seed.quoteRows,
      ].map((r) => r.id),
    );
    for (const r of [
      ...mseed.userRows,
      ...mseed.opRows,
      ...mseed.listingRows,
      ...mseed.rfqRows,
      ...mseed.quoteRows,
    ]) {
      expect(jetsIds.has(r.id!)).toBe(false);
    }
  });

  it("seeds a demo RFQ trail like jets (delivered to pro, delayed for free)", () => {
    expect(mseed.rfqRows).toHaveLength(1);
    const byState = mseed.rfqMatchRows.reduce<Record<string, number>>(
      (m, r) => {
        m[r.state!] = (m[r.state!] ?? 0) + 1;
        return m;
      },
      {},
    );
    expect(byState["sent"]).toBe(1); // alpine-werkzeug, delivered
    expect(byState["delayed"]).toBe(2); // piemonte-macchine + lowlands (free)
    // And a live quote + known buyer token — the inbox demo lands on a
    // payable quote (QA-236).
    expect(mseed.quoteRows).toHaveLength(1);
    expect(mseed.quoteRows[0]!.status).toBe("sent");
    expect(mseed.quoteRows[0]!.currency).toBe("EUR");
    const delivered = mseed.rfqMatchRows.find((m) => m.state === "sent")!;
    expect(mseed.quoteRows[0]!.operatorId).toBe(delivered.operatorId);
  });

  it("validates every listing against the machinery config", () => {
    for (const l of mseed.listingRows) {
      const r = validateNewListing(machineryVertical, {
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

  it("covers all three machinery listing types in EUR", () => {
    const types = new Set(mseed.listingRows.map((l) => l.type));
    expect(types.has("for_sale")).toBe(true);
    expect(types.has("for_rent")).toBe(true);
    expect(types.has("auction")).toBe(true);
    for (const l of mseed.listingRows) expect(l.currency).toBe("EUR");
    // rent listings carry monthlyRentEur
    for (const l of mseed.listingRows.filter((r) => r.type === "for_rent")) {
      expect(l.attributes?.["monthlyRentEur"]).toBeGreaterThan(0);
    }
  });
});
