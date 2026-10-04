/**
 * Deal-close notifications (QA-149): accepting a quote emails the winning
 * operator AND the buyer (their only receipt — buyers never sign in).
 * The mock email provider writes one JSON per message to EMAIL_OUTBOX_DIR;
 * set it before the provider singleton initializes (per-file vitest worker).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_OUTBOX_DIR = mkdtempSync(join(tmpdir(), "jm-outbox-"));

import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import { email } from "@jetmarket/providers";
import { getMemoryRepo } from "../../lib/repo/memory";
import { sessionCookie, signSession } from "../../lib/auth";
import type { Repo } from "../../lib/repo/types";
import { POST as acceptQuote } from "../../app/api/quotes/[id]/accept/route";
import { PATCH as patchListing } from "../../app/api/listings/[id]/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://test.local/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });

beforeEach(() => jar.clear());

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
  const quote = await repo.createQuote({
    rfqId: rfq.id,
    operatorId: op.id,
    amount: 9000,
    currency: "USD",
    message: "",
  });
  return { opUser, op, listing, rfq, quote, buyerEmail };
}

const asUser = (id: string | null, sessionVersion = 1) =>
  id
    ? jar.set(sessionCookie, signSession(id, sessionVersion))
    : jar.delete(sessionCookie);

const patch = (body?: unknown) =>
  new Request("http://test.local/api", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

describe("POST /api/quotes/[id]/accept notifications (QA-149)", () => {
  it("emails the winning operator and the buyer on accept", async () => {
    const repo = await getMemoryRepo();
    const { opUser, quote, rfq, buyerEmail } = await fixture(repo);

    const res = await acceptQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(res.status).toBe(200);

    const box = email.readOutbox(process.env.EMAIL_OUTBOX_DIR);
    const toOp = box.find((m) => m.to === opUser.email);
    const toBuyer = box.find((m) => m.to === buyerEmail);
    expect(toOp?.subject).toContain("accepted");
    expect(toOp?.text).toContain(buyerEmail); // contact handoff
    expect(toOp?.text).toContain("9000");
    expect(toBuyer?.subject).toContain("accepted");
    expect(toBuyer?.text).toContain("Ops");
    // Symmetric handoff (QA-243): the buyer gets the operator's email too —
    // a silent operator must not leave a paid deal stranded.
    expect(toBuyer?.text).toContain(opUser.email);
  });
});

describe("one-off inventory sells out on deal close (QA-498)", () => {
  async function legFixture(repo: Repo, type = "empty_leg") {
    const tag = Math.random().toString(36).slice(2, 8);
    const opUser = await repo.createUser(`op1-${tag}@test.dev`, "operator");
    const op = await repo.upsertOperator({
      userId: opUser.id,
      name: `OneOff ${tag}`,
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    const listing = await repo.createListing({
      operatorId: op.id,
      vertical: "jets",
      type,
      title: `OneOff ${tag}`,
      price: 5000,
      currency: "USD",
      photos: [],
      attributes: {},
    });
    const buyerEmail = `b1-${tag}@test.dev`;
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail,
      fields: {},
    });
    const quote = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: op.id,
      amount: 5000,
      currency: "USD",
      message: "",
    });
    return { opUser, op, listing, rfq, quote, buyerEmail, tag };
  }

  it("accept flips an empty_leg to sold, ends watches, blocks the next deal", async () => {
    const repo = await getMemoryRepo();
    const { listing, rfq, quote, buyerEmail, tag } = await legFixture(repo);
    // An active listing-watch on the leg — the sale must retire it.
    await repo.createSearchAlert({
      vertical: "jets",
      email: `w-${tag}@t.dev`,
      params: { watch: listing.id },
      token: `wt-${tag}`,
      dedupeKey: `wd-${tag}`,
    });
    await repo.confirmSearchAlert(`wt-${tag}`);

    const res = await acceptQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(res.status).toBe(200);
    expect((await repo.getListing(listing.id))?.status).toBe("sold");

    // The watcher was mailed (in their locale) and the alert went 'off'.
    const box = email.readOutbox(process.env.EMAIL_OUTBOX_DIR);
    expect(box.some((m) => m.to === `w-${tag}@t.dev`)).toBe(true);
    const watches = await repo.listSearchAlerts({
      vertical: "jets",
      watchListingId: listing.id,
    });
    expect(watches[0]?.status).toBe("off");

    // A second RFQ on the consumed seat can't mint a second deal — the
    // accept guard treats sold like archived, quote/RFQ stay live.
    const rfq2 = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: `b2-${tag}@test.dev`,
      fields: {},
    });
    const quote2 = await repo.createQuote({
      rfqId: rfq2.id,
      operatorId: quote.operatorId,
      amount: 4000,
      currency: "USD",
      message: "",
    });
    const res2 = await acceptQuote(
      post({ buyerEmail: `b2-${tag}@test.dev`, token: rfq2.accessToken }),
      params(quote2.id),
    );
    expect(res2.status).toBe(409);
    expect((await repo.getQuote(quote2.id))?.status).toBe("sent");
    expect((await repo.getRfq(rfq2.id))?.status).not.toBe("closed");
  });

  it("a charter accept leaves its listing active (capacity, not one-off)", async () => {
    const repo = await getMemoryRepo();
    const { listing, rfq, quote, buyerEmail } = await legFixture(
      repo,
      "charter",
    );
    const res = await acceptQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(res.status).toBe(200);
    expect((await repo.getListing(listing.id))?.status).toBe("active");
  });

  it("PATCH marks a one-off listing sold (terminal); charter refuses sold", async () => {
    const repo = await getMemoryRepo();
    const { opUser, listing } = await legFixture(repo);
    asUser(opUser.id);

    const res = await patchListing(patch({ status: "sold" }), params(listing.id));
    expect(res.status).toBe(200);
    expect((await repo.getListing(listing.id))?.status).toBe("sold");

    // Terminal like archived: every transition out is refused.
    const back = await patchListing(
      patch({ status: "active" }),
      params(listing.id),
    );
    expect(back.status).toBe(403);

    // Capacity listing: 'sold' makes no sense — rejected before any write.
    const { listing: charter, opUser: opUser2 } = await legFixture(
      repo,
      "charter",
    );
    asUser(opUser2.id);
    const bad = await patchListing(
      patch({ status: "sold" }),
      params(charter.id),
    );
    expect(bad.status).toBe(422);
    expect((await repo.getListing(charter.id))?.status).toBe("active");
    asUser(null);
  });

  it("accept sweeps sibling RFQs on the consumed listing (QA-499)", async () => {
    const repo = await getMemoryRepo();
    const { listing, rfq, quote, buyerEmail, tag, op, opUser } =
      await legFixture(repo);
    // A second buyer asked about the same leg before the deal — dead
    // demand now: their request closes and the sent quote declines.
    const rfq2 = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: `b2-${tag}@test.dev`,
      fields: {},
    });
    const quote2 = await repo.createQuote({
      rfqId: rfq2.id,
      operatorId: op.id,
      amount: 4800,
      currency: "USD",
      message: "",
    });
    // Live demand on the operator's OTHER listing must survive the sweep.
    const other = await repo.createListing({
      operatorId: op.id,
      vertical: "jets",
      type: "empty_leg",
      title: `Sibling ${tag}`,
      price: 9000,
      currency: "USD",
      photos: [],
      attributes: {},
    });
    const rfqOther = await repo.createRfq({
      vertical: "jets",
      listingId: other.id,
      buyerEmail: `b3-${tag}@test.dev`,
      fields: {},
    });

    const res = await acceptQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(res.status).toBe(200);
    // Orphaned twin: closed, its quote declined, untouched listings live.
    expect((await repo.getRfq(rfq2.id))?.status).toBe("closed");
    expect((await repo.getQuote(quote2.id))?.status).toBe("declined");
    expect((await repo.getRfq(rfqOther.id))?.status).toBe("open");
    // The operator got the listing-ended decline mail (winner mail is the
    // deal-closed one — matched by subject, not merely by recipient).
    const box = email.readOutbox(process.env.EMAIL_OUTBOX_DIR);
    expect(
      box.some((m) => m.to === opUser.email && /no longer listed/.test(m.subject)),
    ).toBe(true);
    // QA-500: the orphaned BUYER is told why their request closed — they
    // never closed it — with a same-type browse CTA.
    const buyerMail = box.find(
      (m) =>
        m.to === `b2-${tag}@test.dev` &&
        /closed — the listing is no longer available/.test(m.subject),
    );
    expect(buyerMail).toBeTruthy();
    expect(buyerMail!.html).toContain("/search?type=empty_leg");
  });

  it("PATCH archive sweeps the listing's live RFQs too (QA-499)", async () => {
    const repo = await getMemoryRepo();
    const { opUser, listing, rfq, quote } = await legFixture(repo);
    asUser(opUser.id);
    const res = await patchListing(
      patch({ status: "archived" }),
      params(listing.id),
    );
    expect(res.status).toBe(200);
    expect((await repo.getRfq(rfq.id))?.status).toBe("closed");
    expect((await repo.getQuote(quote.id))?.status).toBe("declined");
    asUser(null);
  });
});
