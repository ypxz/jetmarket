/**
 * Buyer concierge (QA-393): $49 expedite — POST /api/rfqs/[id]/concierge
 * with the RFQ bearer token flips `concierge` via repo.expediteRfq and
 * delivers every still-delayed fan-out match immediately (memory mode:
 * inline email, same body as fanout's instant path). Auth mirrors the
 * buyer-close route (email + token binding); terminal RFQs can't be
 * expedited; repeat purchases are idempotent no-ops, never re-charges.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { analyticsProvider, emailProvider } from "@jetmarket/providers";
import { applyPaymentEvent } from "../../lib/billing";
import { getMemoryRepo } from "../../lib/repo/memory";
import type { Repo, Rfq, Operator } from "../../lib/repo/types";
import { POST as conciergePost } from "../../app/api/rfqs/[id]/concierge/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, body: unknown) =>
  conciergePost(
    new Request(`http://test.local/api/rfqs/${id}/concierge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params(id),
  );

let repo: Repo;
let owner: Operator;
let delayedOp: Operator;
let rfq: Rfq;
let sendSpy: ReturnType<typeof vi.spyOn>;

async function fixture(tag = Math.random().toString(36).slice(2, 8)) {
  const ownerUser = await repo.createUser(`cown-${tag}@test.dev`, "operator");
  owner = await repo.upsertOperator({
    userId: ownerUser.id,
    name: `Owner ${tag}`,
    baseAirport: "ZRH",
    fleetSummary: "",
    verified: false,
    plan: "free",
  });
  const delayedUser = await repo.createUser(`cdel-${tag}@test.dev`, "operator");
  delayedOp = await repo.upsertOperator({
    userId: delayedUser.id,
    name: `Delayed ${tag}`,
    baseAirport: "GVA",
    fleetSummary: "",
    verified: false,
    plan: "free",
  });
  const listing = await repo.createListing({
    operatorId: owner.id,
    vertical: "jets",
    type: "charter",
    title: `Concierge Jet ${tag}`,
    price: 9000,
    currency: "USD",
    photos: [],
    attributes: {},
  });
  rfq = await repo.createRfq({
    vertical: "jets",
    listingId: listing.id,
    buyerEmail: `cb-${tag}@test.dev`,
    fields: { name: "Buyer", departure: "ZRH", arrival: "NCE" },
  });
  await repo.createRfqMatches([
    {
      rfqId: rfq.id,
      operatorId: delayedOp.id,
      listingId: listing.id,
      deliverAt: new Date(Date.now() + 86_400_000),
    },
  ]);
}

const body = () => ({ buyerEmail: rfq.buyerEmail, token: rfq.accessToken });

describe("POST /api/rfqs/[id]/concierge", () => {
  beforeEach(async () => {
    repo = await getMemoryRepo();
    sendSpy = vi
      .spyOn(emailProvider(), "send")
      .mockResolvedValue({ id: "m1", to: "x@y.z", subject: "s", at: "2026-01-01T00:00:00Z" });
    await fixture();
  });

  it("rejects unknown RFQs, wrong tokens, and foreign emails as 404", async () => {
    expect(
      (await post(rfq.id, { ...body(), token: "nope" })).status,
    ).toBe(404);
    expect(
      (
        await post(rfq.id, {
          buyerEmail: "other@test.dev",
          token: rfq.accessToken,
        })
      ).status,
    ).toBe(404);
    expect((await post("no-such-rfq", body())).status).toBe(404);
  });

  it("flips concierge, delivers delayed matches and emails them inline (memory)", async () => {
    expect(await repo.hasRfqMatch(rfq.id, delayedOp.id)).toBe(false);
    const res = await post(rfq.id, body());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.concierge).toBe(true);
    expect(data.checkoutUrl).toContain("/billing/mock-payment");

    const after = await repo.getRfq(rfq.id);
    expect(after?.concierge).toBe(true);
    // The paid-for delivery: the delayed match is visible immediately.
    expect(await repo.hasRfqMatch(rfq.id, delayedOp.id)).toBe(true);
    // ... and the operator got the same "new RFQ" email as instant fan-out.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[0]?.to).toContain("cdel-");
    expect(sendSpy.mock.calls[0]?.[0]?.subject).toContain("New RFQ");
  });

  it("is idempotent — a second purchase returns the flag without re-notifying", async () => {
    await post(rfq.id, body());
    sendSpy.mockClear();
    const res = await post(rfq.id, body());
    expect(res.status).toBe(200);
    expect((await res.json()).concierge).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects terminal RFQs — no charge for a dead request", async () => {
    await repo.setRfqStatus(rfq.id, "closed", ["matched"]);
    expect((await post(rfq.id, body())).status).toBe(409);
  });
});

describe("applyPaymentEvent concierge branch", () => {
  beforeEach(async () => {
    repo = await getMemoryRepo();
    sendSpy = vi
      .spyOn(emailProvider(), "send")
      .mockResolvedValue({ id: "m1", to: "x@y.z", subject: "s", at: "2026-01-01T00:00:00Z" });
    await fixture();
  });

  it("payment.completed {kind:concierge} expedites; other kinds no-op", async () => {
    const applied = await applyPaymentEvent(repo, {
      kind: "payment.completed",
      customerId: "cust",
      metadata: { kind: "concierge", rfqId: rfq.id },
    });
    expect(applied).toBe(true);
    expect((await repo.getRfq(rfq.id))?.concierge).toBe(true);
    expect(await repo.hasRfqMatch(rfq.id, delayedOp.id)).toBe(true);

    // Not-concierge one-off payments are acknowledged but unactioned.
    expect(
      await applyPaymentEvent(repo, {
        kind: "payment.completed",
        customerId: "cust",
        metadata: { kind: "other" },
      }),
    ).toBe(false);
    // Replay: the flag's CAS makes the second apply a no-op.
    expect(
      await applyPaymentEvent(repo, {
        kind: "payment.completed",
        customerId: "cust",
        metadata: { kind: "concierge", rfqId: rfq.id },
      }),
    ).toBe(false);
  });

  it("emits concierge_purchased once — a replayed event never double-counts", async () => {
    const trackSpy = vi.spyOn(analyticsProvider(), "track");
    try {
      const event = {
        kind: "payment.completed" as const,
        customerId: "cust",
        metadata: { kind: "concierge", rfqId: rfq.id },
      };
      expect(await applyPaymentEvent(repo, event)).toBe(true);
      expect(trackSpy).toHaveBeenCalledWith({
        name: "concierge_purchased",
        props: { rfqId: rfq.id, amountUsd: 49 },
      });
      trackSpy.mockClear();
      expect(await applyPaymentEvent(repo, event)).toBe(false);
      expect(trackSpy).not.toHaveBeenCalled();
    } finally {
      trackSpy.mockRestore();
    }
  });
});
