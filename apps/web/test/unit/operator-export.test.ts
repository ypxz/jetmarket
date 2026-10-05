/**
 * QA-547 operator export route (GET /api/operator/export): session-only
 * proof (no bearer path — ops always have accounts), the denial matrix,
 * and the JSON download headers. Runs against the memory repo with the
 * real route handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import { sessionCookie, signSession } from "../../lib/auth";
import { getMemoryRepo } from "../../lib/repo/memory";
import type { Repo } from "../../lib/repo/types";
import { GET as exportGet } from "../../app/api/operator/export/route";

const exp = () => exportGet(new Request("http://test.local/api/operator/export"));

let repo: Repo;

beforeEach(async () => {
  jar.clear();
  repo = await getMemoryRepo();
});

describe("operator export (QA-547)", () => {
  it("operator session: downloads the business record as JSON", async () => {
    const tag = Date.now().toString(36);
    const user = await repo.createUser(`oxp-${tag}@test.dev`, "operator");
    const op = await repo.upsertOperator({
      userId: user.id,
      name: "Oxp Air",
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    jar.set(sessionCookie, signSession(user.id, user.sessionVersion));
    const listing = await repo.createListing({
      operatorId: op.id,
      vertical: "jets",
      type: "charter",
      title: "Oxp jet",
      attributes: {},
      photos: [],
      price: 5000,
      currency: "USD",
    });
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: `oxpb-${tag}@test.dev`,
      fields: { email: `oxpb-${tag}@test.dev` },
    });
    const quote = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: op.id,
      amount: 9000,
      currency: "USD",
      message: "terms",
    });
    await repo.setRfqNote(op.id, rfq.id, "priority");
    await repo.upsertQuoteTemplate({
      operatorId: op.id,
      name: "Preset A",
      amount: 1,
      message: "",
    });
    await repo.upsertSubscription({
      operatorId: op.id,
      plan: "pro",
      status: "active",
      currentPeriodEnd: "2026-10-15T00:00:00.000Z",
    });

    const res = await exp();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="jetmarket-operator-export-\d{4}-\d{2}-\d{2}\.json"/,
    );
    expect(res.headers.get("cache-control")).toContain("no-store");
    const data = (await res.json()) as {
      operatorId: string;
      operator: { id: string };
      user?: { id: string };
      listings: { id: string }[];
      quotes: { quote: { id: string } }[];
      rfqNotes: { note: string }[];
      quoteTemplates: { name: string }[];
      subscription?: { plan: string };
    };
    expect(data.operatorId).toBe(op.id);
    expect(data.operator.id).toBe(op.id);
    expect(data.user?.id).toBe(user.id);
    expect(data.listings.map((l) => l.id)).toEqual([listing.id]);
    expect(data.quotes[0]!.quote.id).toBe(quote.id);
    expect(data.rfqNotes[0]!.note).toBe("priority");
    expect(data.quoteTemplates[0]!.name).toBe("Preset A");
    expect(data.subscription?.plan).toBe("pro");
    // Read-only — everything still live.
    expect((await repo.getQuote(quote.id))?.status).toBe("sent");
  });

  it("denials: anonymous → 401; buyer session without profile → 404", async () => {
    expect((await exp()).status).toBe(401);
    const tag = Date.now().toString(36);
    const buyer = await repo.createUser(`oxp-b-${tag}@test.dev`, "buyer");
    jar.set(sessionCookie, signSession(buyer.id, buyer.sessionVersion));
    expect((await exp()).status).toBe(404);
  });
});
