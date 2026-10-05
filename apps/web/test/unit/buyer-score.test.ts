/**
 * POST /api/operator/deals/[id]/rate (QA-528): session-gated once-ever
 * rating of the buyer on a closed deal — foreign deals are 404, replays
 * 409, out-of-range 422.
 */
import { describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import { sessionCookie, signSession } from "../../lib/auth";
import type { Repo } from "../../lib/repo/types";
import { getMemoryRepo } from "../../lib/repo/memory";
import { POST as rateDeal } from "../../app/api/operator/deals/[id]/rate/route";

const asUser = (id: string | null) =>
  id
    ? jar.set(sessionCookie, signSession(id, 1))
    : jar.delete(sessionCookie);
const post = (body?: unknown) =>
  new Request("http://test.local/api/operator/deals/x/rate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function fixture(repo: Repo) {
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
  const rfq = await repo.createRfq({
    vertical: "jets",
    listingId: null,
    buyerEmail: `b-${tag}@test.dev`,
    fields: {},
  });
  const quote = await repo.createQuote({
    rfqId: rfq.id,
    operatorId: op.id,
    amount: 9000,
    currency: "USD",
    message: "",
  });
  const deal = await repo.createDeal({
    quoteId: quote.id,
    operatorId: op.id,
    amount: 9000,
    currency: "USD",
    feePct: 0.03,
    feeAmount: 270,
    invoiceStatus: "pending",
  });
  return { opUser, op, deal };
}

describe("POST /api/operator/deals/[id]/rate (QA-528)", () => {
  it("401 unauth / 409 no-profile / 422 out-of-range", async () => {
    const repo = await getMemoryRepo();
    const { opUser, deal } = await fixture(repo);
    asUser(null);
    expect((await rateDeal(post({ rating: 5 }), params(deal.id))).status).toBe(401);

    const lonely = await repo.createUser(
      `lonely-${Math.random().toString(36).slice(2, 6)}@test.dev`,
      "operator",
    );
    asUser(lonely.id);
    expect((await rateDeal(post({ rating: 5 }), params(deal.id))).status).toBe(409);

    asUser(opUser.id);
    expect((await rateDeal(post({ rating: 0 }), params(deal.id))).status).toBe(422);
    expect((await rateDeal(post({ rating: 6 }), params(deal.id))).status).toBe(422);
    expect((await rateDeal(post({ rating: 2.5 }), params(deal.id))).status).toBe(422);
    expect((await rateDeal(post(), params(deal.id))).status).toBe(422);
  });

  it("owner rates once; foreign deal 404s; replay 409s", async () => {
    const repo = await getMemoryRepo();
    const { opUser, deal } = await fixture(repo);
    const other = await repo.createUser(
      `other-${Math.random().toString(36).slice(2, 6)}@test.dev`,
      "operator",
    );
    await repo.upsertOperator({
      userId: other.id,
      name: "Other",
      baseAirport: "GVA",
      fleetSummary: "",
      verified: true,
      plan: "free",
    });
    asUser(other.id);
    // Not theirs — the route can't confirm the deal exists to a stranger.
    expect((await rateDeal(post({ rating: 1 }), params(deal.id))).status).toBe(404);
    expect((await repo.getDeal(deal.id))?.operatorRating).toBeUndefined();

    asUser(opUser.id);
    const res = await rateDeal(post({ rating: 4 }), params(deal.id));
    expect(res.status).toBe(200);
    expect((await repo.getDeal(deal.id))?.operatorRating).toBe(4);
    expect((await rateDeal(post({ rating: 5 }), params(deal.id))).status).toBe(409);

    // Unknown id misses before any write.
    expect(
      (await rateDeal(post({ rating: 5 }), params(crypto.randomUUID()))).status,
    ).toBe(404);
    asUser(null);
  });

  it("QA-551: a voided deal isn't rateable — 409 before the CAS", async () => {
    const repo = await getMemoryRepo();
    const { opUser, deal } = await fixture(repo);
    await repo.setDealInvoice(deal.id, "void", undefined, ["pending"]);
    asUser(opUser.id);
    expect((await rateDeal(post({ rating: 1 }), params(deal.id))).status).toBe(
      409,
    );
    expect((await repo.getDeal(deal.id))?.operatorRating).toBeUndefined();
    asUser(null);
  });
});
