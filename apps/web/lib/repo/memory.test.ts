import { describe, expect, it } from "vitest";
import { FREE_LISTING_LIMIT, successFeePctFor } from "../fees";
import { signSession, verifySession } from "../auth";
import { createMemoryRepo } from "./memory";

describe("memory repo (seeded)", () => {
  const repo = createMemoryRepo();

  it("seeds operators and listings", () => {
    expect(repo.listOperators().length).toBeGreaterThanOrEqual(4);
    expect(repo.listListings({ vertical: "jets" }).length).toBeGreaterThanOrEqual(8);
  });

  it("filters listings by type, query and facets", () => {
    const legs = repo.listListings({ vertical: "jets", type: "empty_leg" });
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.every((l) => l.type === "empty_leg")).toBe(true);
    const zrh = repo.listListings({ vertical: "jets", query: "zurich" });
    expect(zrh.length).toBeGreaterThan(0);
    const light = repo.listListings({
      vertical: "jets",
      facets: { aircraftCategory: "light" },
    });
    expect(light.every((l) => l.attributes.aircraftCategory === "light")).toBe(true);
  });

  it("tracks rfqs per operator listing and quote lifecycle", () => {
    const listing = repo.listListings({ vertical: "jets" })[0]!;
    const rfq = repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: "b@x.example",
      fields: { pax: 2 },
    });
    expect(repo.listRfqs({ operatorId: listing.operatorId })).toHaveLength(1);
    const q = repo.createQuote({
      rfqId: rfq.id,
      operatorId: listing.operatorId,
      amount: 1000,
      currency: "USD",
      message: "",
    });
    expect(repo.getRfq(rfq.id)!.status).toBe("quoted");
    repo.setQuoteStatus(q.id, "accepted");
    expect(repo.getQuote(q.id)!.status).toBe("accepted");
  });

  it("counts operator listings for the plan limit", () => {
    const op = repo.listOperators().find((o) => o.plan === "free")!;
    expect(repo.countOperatorListings(op.id)).toBeGreaterThan(0);
    expect(typeof FREE_LISTING_LIMIT).toBe("number");
  });
});

describe("fees", () => {
  it("reads success fee pct from the vertical config (percent → fraction)", () => {
    expect(successFeePctFor("charter")).toBeCloseTo(0.03);
    expect(successFeePctFor("aircraft_sale")).toBeCloseTo(0.015);
    expect(successFeePctFor("nonexistent")).toBeCloseTo(0.03);
  });
});

describe("session signing", () => {
  it("round-trips and rejects tampering", () => {
    const token = signSession("usr_test1");
    expect(verifySession(token)).toBe("usr_test1");
    expect(verifySession("usr_test1.deadbeef")).toBeNull();
    expect(verifySession("garbage")).toBeNull();
    expect(verifySession(undefined)).toBeNull();
  });
});
