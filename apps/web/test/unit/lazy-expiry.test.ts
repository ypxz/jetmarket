/**
 * QA-142 — memory mode has no worker tick, so repo.expireRfqs would never
 * run: a stale RFQ (dateTo in the past) stayed "open" forever and kept
 * accepting quotes, and inboxes showed it live. The sweep now runs lazily on
 * the routes that gate on RFQ live-state.
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
import { getMemoryRepo } from "../../lib/repo/memory";
import { POST as createQuote } from "../../app/api/quotes/route";
import { GET as operatorRfqs } from "../../app/api/operator/rfqs/route";

async function fixture() {
  const repo = await getMemoryRepo();
  const user = await repo.createUser("op@test.dev", "operator");
  const operator = await repo.upsertOperator({
    userId: user.id,
    name: "Test Operator",
    baseAirport: "ZRH",
    fleetSummary: "2 aircraft",
    verified: true,
    plan: "pro",
  });
  const listing = await repo.createListing({
    operatorId: operator.id,
    vertical: "jets",
    type: "charter",
    title: "Test jet",
    attributes: { aircraftCategory: "light" },
    price: 500_000,
    currency: "USD",
    photos: [],
  });
  jar.set(sessionCookie, signSession(user.id, user.sessionVersion));
  return { repo, operator, listing };
}

const postQuote = (rfqId: string) =>
  createQuote(
    new Request("http://test.local/api/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rfqId, amount: 1000, message: "" }),
    }),
  );

const staleRfq = (
  repo: Awaited<ReturnType<typeof getMemoryRepo>>,
  listingId: string,
) =>
  repo.createRfq({
    vertical: "jets",
    listingId,
    buyerEmail: "buyer@test.dev",
    fields: {
      departure: "ZRH",
      arrival: "NCE",
      passengers: 2,
      dateFrom: "2020-01-01",
      dateTo: "2020-01-02", // long past
    },
  });

describe("lazy RFQ expiry (memory mode, QA-142)", () => {
  it("rejects a quote on a dateTo-past RFQ and flips it expired", async () => {
    const { repo, listing } = await fixture();
    const stale = await staleRfq(repo, listing.id);
    expect(stale.status).toBe("open"); // created open — no sweep has run

    const res = await postQuote(stale.id);
    expect(res.status).toBe(409);
    expect((await repo.getRfq(stale.id))?.status).toBe("expired");
  });

  it("still accepts a quote on a live RFQ (sweep is non-destructive)", async () => {
    const { repo, listing } = await fixture();
    const live = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: "buyer2@test.dev",
      fields: {
        departure: "ZRH",
        arrival: "NCE",
        passengers: 2,
        dateFrom: "2099-01-01",
        dateTo: "2099-01-02",
      },
    });
    const res = await postQuote(live.id);
    expect(res.status).toBe(201);
    expect((await repo.getRfq(live.id))?.status).toBe("quoted");
  });

  it("sweeps on the operator inbox read — stale RFQ renders expired", async () => {
    const { repo, listing } = await fixture();
    const stale = await staleRfq(repo, listing.id);

    const res = await operatorRfqs(
      new Request("http://test.local/api/operator/rfqs"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string }[];
    const row = body.find((r) => r.id === stale.id);
    expect(row?.status).toBe("expired");
  });
});
