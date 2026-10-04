/**
 * Buyer "New" chip (QA-531): the inbox GET stamps buyer_seen_at on every
 * quote it returns (QA-506), so the wire must carry the PRE-stamp truth —
 * wasUnseen marks exactly the rows this load is the buyer's first look
 * at. A revise clears the stamp, so a re-revised offer re-flags New.
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

describe("GET /api/buyer/quotes wasUnseen (QA-531)", () => {
  it("fresh offer flags once, stamped rows don't; a revise re-flags", async () => {
    const repo = await getMemoryRepo();
    const tag = Math.random().toString(36).slice(2, 8);
    const opUser = await repo.createUser(`un-o-${tag}@test.dev`, "operator");
    const op = await repo.upsertOperator({
      userId: opUser.id,
      name: `Unseen Ops ${tag}`,
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: true,
      plan: "free",
    });
    const listing = await repo.createListing({
      operatorId: op.id,
      vertical: "jets",
      type: "charter",
      title: `Unseen Jet ${tag}`,
      price: 9000,
      currency: "USD",
      photos: [],
      attributes: {},
    });
    const buyerEmail = `un-b-${tag}@test.dev`;
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail,
      fields: {},
    });
    const first = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: op.id,
      amount: 12000,
      currency: "USD",
      message: "",
    });

    // First load: the offer was never viewed — flagged New.
    const res1 = await buyerQuotes(get(buyerEmail, rfq.accessToken));
    expect(res1.status).toBe(200);
    const rows1 = (await res1.json()) as {
      quotes: { id: string; wasUnseen?: boolean }[];
    }[];
    expect(rows1[0]!.quotes).toHaveLength(1);
    expect(rows1[0]!.quotes[0]!.wasUnseen).toBe(true);

    // That same GET stamped it — a reload sees a seen row: chip retires.
    const res2 = await buyerQuotes(get(buyerEmail, rfq.accessToken));
    const rows2 = (await res2.json()) as {
      quotes: { id: string; wasUnseen?: boolean }[];
    }[];
    expect(rows2[0]!.quotes[0]!.wasUnseen).toBe(false);

    // A NEW offer on the same RFQ flags independently of the seen one.
    const second = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: op.id,
      amount: 11500,
      currency: "USD",
      message: "",
    });
    const res3 = await buyerQuotes(get(buyerEmail, rfq.accessToken));
    const rows3 = (await res3.json()) as {
      quotes: { id: string; wasUnseen?: boolean }[];
    }[];
    const byId3 = new Map(rows3[0]!.quotes.map((q) => [q.id, q.wasUnseen]));
    expect(byId3.get(first.id)).toBe(false);
    expect(byId3.get(second.id)).toBe(true);

    // A revise clears the seen stamp (QA-506) — new terms are new
    // content: the SAME quote re-flags New on the next load.
    const revised = await repo.reviseQuote(second.id, op.id, {
      amount: 11000,
      currency: "USD",
      message: "sharpened",
    });
    expect(revised).not.toBeNull();
    const res4 = await buyerQuotes(get(buyerEmail, rfq.accessToken));
    const rows4 = (await res4.json()) as {
      quotes: { id: string; wasUnseen?: boolean }[];
    }[];
    const byId4 = new Map(rows4[0]!.quotes.map((q) => [q.id, q.wasUnseen]));
    expect(byId4.get(second.id)).toBe(true);
  });
});
