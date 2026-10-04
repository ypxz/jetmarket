/**
 * Buyer quotes inbox ordering (QA-414): a buyer compares offers, so the
 * API hands quotes back cheapest-first (createdAt tiebreak) instead of
 * the repo's newest-first. Acceptance flow is unchanged — this pins the
 * sort only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { getMemoryRepo } from "../../lib/repo/memory";
import { GET as buyerQuotes } from "../../app/api/buyer/quotes/route";

const get = (email: string, token: string) =>
  new Request(
    `http://test.local/api/buyer/quotes?email=${encodeURIComponent(email)}`,
    { headers: { "x-rfq-token": token } },
  );

describe("GET /api/buyer/quotes ordering (QA-414)", () => {
  it("quotes on an RFQ arrive cheapest-first, stable on price ties", async () => {
    const repo = await getMemoryRepo();
    const tag = Math.random().toString(36).slice(2, 8);
    const opUser = await repo.createUser(`op-${tag}@test.dev`, "operator");
    const op = await repo.upsertOperator({
      userId: opUser.id,
      name: `Ops ${tag}`,
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    const listing = await repo.createListing({
      operatorId: op.id,
      vertical: "jets",
      type: "charter",
      title: `Jet ${tag}`,
      price: 9000,
      currency: "USD",
      photos: [],
      attributes: {},
    });
    const buyerEmail = `buyer-${tag}@test.dev`;
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail,
      fields: {},
    });
    // Inserted newest→oldest by price on purpose — repo order is createdAt
    // desc, so a pass-through would yield exactly the wrong order.
    const expensive = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: op.id,
      amount: 9000,
      currency: "USD",
      message: "",
    });
    const middle = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: op.id,
      amount: 7000,
      currency: "USD",
      message: "",
    });
    const cheap = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: op.id,
      amount: 5000,
      currency: "USD",
      message: "",
    });

    const res = await buyerQuotes(get(buyerEmail, rfq.accessToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      quotes: { id: string; amount: number }[];
    }[];
    const row = body.find((r) => r.quotes.length === 3);
    expect(row?.quotes.map((q) => q.id)).toEqual([
      cheap.id,
      middle.id,
      expensive.id,
    ]);
  });
});
