import { describe, expect, it } from "vitest";
import { FREE_LISTING_LIMIT, successFeePctFor } from "../fees";
import { signSession, verifySession } from "../auth";
import { createMemoryRepo } from "./memory";

describe("memory repo (seeded)", async () => {
  const repo = await createMemoryRepo();

  it("seeds operators and listings", async () => {
    expect((await repo.listOperators()).length).toBeGreaterThanOrEqual(4);
    expect(
      (await repo.listListings({ vertical: "jets" })).length,
    ).toBeGreaterThanOrEqual(8);
  });

  it("filters listings by type, query and facets", async () => {
    const legs = await repo.listListings({ vertical: "jets", type: "empty_leg" });
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.every((l) => l.type === "empty_leg")).toBe(true);
    const zrh = await repo.listListings({ vertical: "jets", query: "zurich" });
    expect(zrh.length).toBeGreaterThan(0);
    const light = await repo.listListings({
      vertical: "jets",
      facets: { aircraftCategory: "light" },
    });
    expect(light.every((l) => l.attributes.aircraftCategory === "light")).toBe(
      true,
    );
  });

  it("tracks rfqs per operator listing and quote lifecycle", async () => {
    const listing = (await repo.listListings({ vertical: "jets" }))[0]!;
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: "b@x.example",
      fields: { pax: 2 },
    });
    expect(await repo.listRfqs({ operatorId: listing.operatorId })).toHaveLength(1);
    const q = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: listing.operatorId,
      amount: 1000,
      currency: "USD",
      message: "",
    });
    expect((await repo.getRfq(rfq.id))!.status).toBe("quoted");
    await repo.setQuoteStatus(q.id, "accepted");
    expect((await repo.getQuote(q.id))!.status).toBe("accepted");
  });

  it("counts operator listings for the plan limit", async () => {
    const op = (await repo.listOperators()).find((o) => o.plan === "free")!;
    expect(await repo.countOperatorListings(op.id)).toBeGreaterThan(0);
    expect(typeof FREE_LISTING_LIMIT).toBe("number");
  });

  it("records a success-fee invoice on a deal", async () => {
    const quote = (await repo.listQuotes()).find((q) => q.status === "sent");
    const q =
      quote ??
      (await repo.createQuote({
        rfqId: (await repo.listRfqs())[0]!.id,
        operatorId: (await repo.listOperators())[0]!.id,
        amount: 6000,
        currency: "USD",
        message: "q",
      }));
    const deal = await repo.createDeal({
      quoteId: q.id,
      operatorId: q.operatorId,
      amount: q.amount,
      feePct: 0.03,
      feeAmount: Math.round(q.amount * 3) / 100,
      invoiceStatus: "pending",
    });
    expect(deal.invoiceStatus).toBe("pending");

    await repo.setDealInvoice(deal.id, "invoiced", "inv_test1");
    const stored = (await repo.listDeals()).find((d) => d.id === deal.id)!;
    expect(stored.invoiceStatus).toBe("invoiced");
    expect(stored.invoiceRef).toBe("inv_test1");
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
