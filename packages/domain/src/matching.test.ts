import { describe, expect, it } from "vitest";
import {
  defaultRequirementExtractor,
  deliverAt,
  matchOperators,
  type OperatorCandidate,
} from "./matching";
import { defaultPlans, FREE_PLAN_ID, PRO_PLAN_ID } from "./plans";

const plans = defaultPlans();

function op(partial: Partial<OperatorCandidate> & { id: string }): OperatorCandidate {
  return {
    verified: true,
    planId: PRO_PLAN_ID,
    baseAirport: "ZRH",
    fleet: [],
    ...partial,
  };
}

describe("defaultRequirementExtractor", () => {
  it("reads the documented field conventions", () => {
    expect(
      defaultRequirementExtractor({
        category: "Mid",
        pax: "6",
        departure: "zrh",
        arrival: "nce",
      }),
    ).toEqual({ category: "mid", seats: 6, departure: "ZRH", arrival: "NCE" });
  });

  it("tolerates missing/alternate keys", () => {
    expect(defaultRequirementExtractor({ passengers: 4, from: "LTN" })).toEqual({
      seats: 4,
      departure: "LTN",
    });
    expect(defaultRequirementExtractor({})).toEqual({});
    expect(defaultRequirementExtractor({ seats: "abc" })).toEqual({});
  });
});

describe("matchOperators", () => {
  it("matches category + seats fit, instant for verified pro", () => {
    const results = matchOperators(
      { category: "light", pax: 6, departure: "ZRH" },
      [
        op({
          id: "o1",
          fleet: [{ category: "light", seats: 8, listingId: "l1" }],
        }),
        op({
          id: "o2",
          fleet: [{ category: "heavy", seats: 14, listingId: "l2" }],
        }),
      ],
      plans,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      operatorId: "o1",
      listingId: "l1",
      delivery: "instant",
      delayMinutes: 0,
    });
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("delays unverified and free-plan operators", () => {
    const results = matchOperators(
      { departure: "ZRH" },
      [
        op({ id: "pro-verified" }),
        op({ id: "pro-unverified", verified: false }),
        op({ id: "free-verified", planId: FREE_PLAN_ID }),
      ],
      plans,
    );
    const byId = Object.fromEntries(results.map((r) => [r.operatorId, r]));
    expect(byId["pro-verified"]).toMatchObject({
      delivery: "instant",
      delayMinutes: 0,
    });
    expect(byId["pro-unverified"]).toMatchObject({ delivery: "delayed" });
    expect(byId["free-verified"]).toMatchObject({ delivery: "delayed" });
    expect(byId["pro-unverified"]!.delayMinutes).toBeGreaterThan(0);
  });

  it("drops operators who cannot prove category fit", () => {
    const results = matchOperators(
      { category: "ultra-long" },
      [
        op({ id: "has-ultra", fleet: [{ category: "ultra-long" }] }),
        op({ id: "no-category", fleet: [{}] }),
        op({ id: "wrong-cat", fleet: [{ category: "light" }] }),
        op({ id: "no-fleet" }),
      ],
      plans,
    );
    expect(results.map((r) => r.operatorId)).toEqual(["has-ultra"]);
  });

  it("hard-filters seats but tolerates unknown seat data", () => {
    const results = matchOperators(
      { pax: 12 },
      [
        op({ id: "too-small", fleet: [{ seats: 4 }] }),
        op({ id: "fits", fleet: [{ seats: 14 }] }),
        op({ id: "unknown", fleet: [{}] }),
      ],
      plans,
    );
    expect(results.map((r) => r.operatorId).sort()).toEqual([
      "fits",
      "unknown",
    ]);
  });

  it("ranks same-region operators higher and applies the limit", () => {
    const near = op({ id: "b-zrh", baseAirport: "ZRH", fleet: [{}] });
    const far = op({ id: "a-teb", baseAirport: "TEB", fleet: [{}] });
    const results = matchOperators(
      { departure: "GVA" },
      [far, near],
      plans,
      { limit: 1 },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.operatorId).toBe("b-zrh");
  });

  it("excludes given operator ids (listing's own operator)", () => {
    const results = matchOperators(
      {},
      [op({ id: "self" }), op({ id: "other" })],
      plans,
      { excludeOperatorIds: new Set(["self"]) },
    );
    expect(results.map((r) => r.operatorId)).toEqual(["other"]);
  });

  it("verified operators score a small boost, ties are deterministic", () => {
    const results = matchOperators(
      {},
      [op({ id: "b", verified: false }), op({ id: "a", verified: true })],
      plans,
    );
    expect(results[0]!.operatorId).toBe("a"); // verified +1
    const again = matchOperators(
      {},
      [op({ id: "a", verified: true }), op({ id: "b", verified: true })],
      plans,
    );
    expect(again.map((r) => r.operatorId)).toEqual(["a", "b"]); // alpha tiebreak
  });

  it("supports a custom extractor and region map", () => {
    const results = matchOperators(
      { want: "big" },
      [op({ id: "x", baseAirport: "AAA", fleet: [{ category: "big" }] })],
      plans,
      {
        extract: () => ({ category: "big", departure: "AAA" }),
        regionMap: { AAA: "R" },
      },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBe(4); // category 2 + region 1 + verified 1
  });
});

describe("deliverAt", () => {
  it("adds the delay in minutes", () => {
    const at = new Date("2026-09-15T00:00:00Z");
    const d = deliverAt(
      {
        operatorId: "o",
        listingId: null,
        score: 0,
        delivery: "delayed",
        delayMinutes: 360,
      },
      at,
    );
    expect(d.toISOString()).toBe("2026-09-15T06:00:00.000Z");
  });
});
