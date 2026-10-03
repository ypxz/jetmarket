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
    // ... and the operator got the same "new RFQ" email as instant fan-out,
    // flagged as a paid expedite (QA-396).
    const toOp = sendSpy.mock.calls.find((c: unknown[]) =>
      /cdel-/.test((c[0] as { to?: string })?.to ?? ""),
    );
    expect(toOp?.[0]?.subject).toContain("New RFQ");
    expect(toOp?.[0]?.text).toContain(
      "Priority request — the buyer paid for immediate delivery.",
    );
    // ... and the paying buyer got their concierge receipt — the only
    // channel a buyer has (QA-398): $49 confirm + deep link back to the
    // inbox, bearer token in the fragment.
    const receipt = sendSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as { to?: string })?.to === rfq.buyerEmail,
    );
    expect(receipt?.[0]?.subject).toContain("Concierge active");
    expect(receipt?.[0]?.text).toContain("$49");
    expect(receipt?.[0]?.text).toContain(
      `/quotes?email=${encodeURIComponent(rfq.buyerEmail)}`,
    );
    expect(receipt?.[0]?.text).toContain(`#t=${rfq.accessToken}`);
  });

  it("is idempotent — a second purchase returns the flag without re-notifying", async () => {
    await post(rfq.id, body());
    // First purchase: operator mail + exactly one buyer receipt (QA-398).
    expect(
      sendSpy.mock.calls.filter(
        (c: unknown[]) => (c[0] as { to?: string })?.to === rfq.buyerEmail,
      ),
    ).toHaveLength(1);
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

  it("409s when nothing is left to expedite — $49 must deliver something (QA-397)", async () => {
    // Fresh RFQ whose only match is already delivered (no deliverAt).
    const listing = await repo.createListing({
      operatorId: owner.id,
      vertical: "jets",
      type: "charter",
      title: "Instant Jet",
      price: 8000,
      currency: "USD",
      photos: [],
      attributes: {},
    });
    const rfq2 = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: "cb-instant@test.dev",
      fields: { name: "Buyer" },
    });
    await repo.createRfqMatches([
      { rfqId: rfq2.id, operatorId: delayedOp.id, listingId: listing.id },
    ]);
    expect(await repo.countRfqPendingMatches(rfq2.id)).toBe(0);
    const res = await post(rfq2.id, {
      buyerEmail: rfq2.buyerEmail,
      token: rfq2.accessToken,
    });
    expect(res.status).toBe(409);
    // No charge happened — no concierge flag, no email.
    expect((await repo.getRfq(rfq2.id))?.concierge).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
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
        name: "rfq_concierge_paid",
        props: { rfqId: rfq.id, delivered: 1, amountUsd: 49 },
      });
      // One event per purchase — no second revenue event for the same flip.
      expect(
        trackSpy.mock.calls.filter(
          (c) => (c[0] as { name?: string }).name === "rfq_concierge_paid",
        ),
      ).toHaveLength(1);
      trackSpy.mockClear();
      expect(await applyPaymentEvent(repo, event)).toBe(false);
      expect(trackSpy).not.toHaveBeenCalled();
    } finally {
      trackSpy.mockRestore();
    }
  });
});
