/**
 * Quote lifecycle routes (T27) — handlers invoked directly against the
 * seeded in-memory repo (getRepo() picks memory with no DATABASE_URL).
 * next/headers cookies are mocked to drive requireUser's signed session.
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
import type { Quote, Repo } from "../../lib/repo/types";
import { POST as createQuote } from "../../app/api/quotes/route";
import { POST as acceptQuote } from "../../app/api/quotes/[id]/accept/route";
import { POST as declineQuote } from "../../app/api/quotes/[id]/decline/route";
import {
  POST as counterQuote,
  DELETE as withdrawCounter,
} from "../../app/api/quotes/[id]/counter/route";
import { POST as acceptCounter } from "../../app/api/quotes/[id]/accept-counter/route";
import { POST as declineCounter } from "../../app/api/quotes/[id]/decline-counter/route";
import { POST as withdrawQuote } from "../../app/api/quotes/[id]/withdraw/route";
import { POST as markPaid } from "../../app/api/admin/deals/[id]/paid/route";
import { POST as moderateListing } from "../../app/api/admin/listings/[id]/status/route";
import { POST as moderateRfq } from "../../app/api/admin/rfqs/[id]/status/route";
import { POST as closeRfq } from "../../app/api/rfqs/[id]/close/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://test.local/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
const del = (body?: unknown) =>
  new Request("http://test.local/api", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });

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
  const otherUser = await repo.createUser(`op2-${tag}@test.dev`, "operator");
  const otherOp = await repo.upsertOperator({
    userId: otherUser.id,
    name: `Other ${tag}`,
    baseAirport: "GVA",
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
  return { opUser, op, otherUser, otherOp, listing, rfq, quote, buyerEmail };
}

const asUser = (id: string | null, sessionVersion = 1) =>
  id
    ? jar.set(sessionCookie, signSession(id, sessionVersion))
    : jar.delete(sessionCookie);

beforeEach(() => jar.clear());

describe("POST /api/quotes/[id]/decline (buyer)", () => {
  it("declines a sent quote for its buyer; wrong email 403; replay 409", async () => {
    const repo = await getMemoryRepo();
    const { quote, buyerEmail, rfq } = await fixture(repo);

    const bad = await declineQuote(
      post({ buyerEmail: "nope@x.dev", token: rfq.accessToken }),
      params(quote.id),
    );
    expect(bad.status).toBe(403);

    const res = await declineQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Quote).status).toBe("declined");
    expect((await repo.getQuote(quote.id))?.status).toBe("declined");

    const again = await declineQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(again.status).toBe(409);
  });

  it("404s on unknown quote", async () => {
    const res = await declineQuote(
      post({ buyerEmail: "b@x.dev", token: "t" }),
      params("quo_missing"),
    );
    expect(res.status).toBe(404);
  });

  it("QA-508: stores a valid decline reason; an unknown reason 422s", async () => {
    const repo = await getMemoryRepo();
    const { quote, buyerEmail, rfq } = await fixture(repo);

    const bad = await declineQuote(
      post({ buyerEmail, token: rfq.accessToken, reason: "rude" }),
      params(quote.id),
    );
    expect(bad.status).toBe(422);
    // A rejected reason mutates nothing.
    expect((await repo.getQuote(quote.id))?.status).toBe("sent");

    const res = await declineQuote(
      post({ buyerEmail, token: rfq.accessToken, reason: "price" }),
      params(quote.id),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Quote).declineReason).toBe("price");
    expect((await repo.getQuote(quote.id))?.declineReason).toBe("price");
  });
});

describe("POST /api/quotes re-quote (QA-18)", () => {
  it("409s a live duplicate; re-quote allowed after withdraw; then 409", async () => {
    const repo = await getMemoryRepo();
    const { opUser, op, listing, rfq, quote } = await fixture(repo);

    asUser(opUser.id);
    // a live 'sent' quote already exists for this rfq+operator
    const dup = await createQuote(
      post({ rfqId: rfq.id, amount: 8000, message: "dup" }),
    );
    expect(dup.status).toBe(409);

    // withdraw it, then the same operator may quote again
    const wd = await withdrawQuote(post(), params(quote.id));
    expect(wd.status).toBe(200);
    const req = await createQuote(
      post({ rfqId: rfq.id, amount: 8500, message: "re" }),
    );
    expect(req.status).toBe(201);

    // and the fresh live quote blocks another
    const dup2 = await createQuote(
      post({ rfqId: rfq.id, amount: 8600 }),
    );
    expect(dup2.status).toBe(409);
    void op;
    void listing;
  });

  it("QA-510: re-quote allowed after the buyer declines (win-back)", async () => {
    const repo = await getMemoryRepo();
    const { opUser, quote, buyerEmail, rfq } = await fixture(repo);

    // Buyer declines 'too expensive' — the quote goes terminal.
    const d = await declineQuote(
      post({ buyerEmail, token: rfq.accessToken, reason: "price" }),
      params(quote.id),
    );
    expect(d.status).toBe(200);

    // The operator can now mint a sharper offer on the same RFQ.
    asUser(opUser.id);
    const req = await createQuote(
      post({ rfqId: rfq.id, amount: 7800, message: "sharper" }),
    );
    expect(req.status).toBe(201);
    const fresh = (await req.json()) as Quote;
    expect(fresh.status).toBe("sent");
    expect(fresh.id).not.toBe(quote.id);
    // The declined row keeps its reason — history isn't rewritten.
    expect((await repo.getQuote(quote.id))?.declineReason).toBe("price");
  });
});

describe("POST /api/quotes/[id]/counter (buyer, QA-511)", () => {
  it("stamps the counter on a sent quote; guards replay/dupes/ask+ errors", async () => {
    const repo = await getMemoryRepo();
    const { quote, buyerEmail, rfq } = await fixture(repo);

    const bad = await counterQuote(
      post({ buyerEmail: "nope@x.dev", token: rfq.accessToken, amount: 8000 }),
      params(quote.id),
    );
    expect(bad.status).toBe(403);

    // A counter at or above the ask is pointless — just accept.
    const high = await counterQuote(
      post({ buyerEmail, token: rfq.accessToken, amount: 9000 }),
      params(quote.id),
    );
    expect(high.status).toBe(422);
    const junk = await counterQuote(
      post({ buyerEmail, token: rfq.accessToken, amount: -5 }),
      params(quote.id),
    );
    expect(junk.status).toBe(422);
    expect((await repo.getQuote(quote.id))?.counteredAt).toBeUndefined();

    const res = await counterQuote(
      post({ buyerEmail, token: rfq.accessToken, amount: 8000 }),
      params(quote.id),
    );
    expect(res.status).toBe(200);
    const stamped = (await res.json()) as Quote;
    expect(stamped.counterAmount).toBe(8000);
    expect(stamped.counteredAt).toBeDefined();
    expect(stamped.status).toBe("sent");

    // One counter per offer round.
    const again = await counterQuote(
      post({ buyerEmail, token: rfq.accessToken, amount: 7000 }),
      params(quote.id),
    );
    expect(again.status).toBe(409);
  });

  it("QA-521: carries the buyer's one-line note; oversized notes 422", async () => {
    const repo = await getMemoryRepo();
    const { quote, buyerEmail, rfq } = await fixture(repo);

    // 501 chars over the note cap → invalid fields, nothing stored.
    const wordy = await counterQuote(
      post({
        buyerEmail,
        token: rfq.accessToken,
        amount: 8000,
        note: "x".repeat(501),
      }),
      params(quote.id),
    );
    expect(wordy.status).toBe(422);

    const res = await counterQuote(
      post({
        buyerEmail,
        token: rfq.accessToken,
        amount: 8000,
        note: "  includes repositioning  ",
      }),
      params(quote.id),
    );
    expect(res.status).toBe(200);
    const stamped = (await res.json()) as Quote;
    expect(stamped.counterAmount).toBe(8000);
    expect(stamped.counterMessage).toBe("includes repositioning");

    // The withdraw + fresh round clears the note with the counter.
    const w = await withdrawCounter(
      del({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(w.status).toBe(200);
    expect((await repo.getQuote(quote.id))!.counterMessage).toBeUndefined();
    const fresh = await counterQuote(
      post({ buyerEmail, token: rfq.accessToken, amount: 7000 }),
      params(quote.id),
    );
    expect(fresh.status).toBe(200);
    // No note this round — nothing lingers from the last one.
    expect(((await fresh.json()) as Quote).counterMessage).toBeUndefined();
  });

  it("404s on unknown quote; 409s once the quote left 'sent'", async () => {
    const missing = await counterQuote(
      post({ buyerEmail: "b@x.dev", token: "t", amount: 1 }),
      params("quo_missing"),
    );
    expect(missing.status).toBe(404);

    const repo = await getMemoryRepo();
    const { quote, buyerEmail, rfq } = await fixture(repo);
    await declineQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    const res = await counterQuote(
      post({ buyerEmail, token: rfq.accessToken, amount: 8000 }),
      params(quote.id),
    );
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/quotes/[id]/counter (buyer, QA-518)", () => {
  it("pulls a live counter; guards strangers/replays/terminal", async () => {
    const repo = await getMemoryRepo();
    const { quote, buyerEmail, rfq } = await fixture(repo);

    // No counter on the table yet — nothing to pull.
    const early = await withdrawCounter(
      del({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(early.status).toBe(409);

    await counterQuote(
      post({ buyerEmail, token: rfq.accessToken, amount: 8000 }),
      params(quote.id),
    );
    // A stranger can't pull it.
    const stranger = await withdrawCounter(
      del({ buyerEmail: "nope@x.dev", token: rfq.accessToken }),
      params(quote.id),
    );
    expect(stranger.status).toBe(403);

    const res = await withdrawCounter(
      del({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(res.status).toBe(200);
    const cleared = (await res.json()) as Quote;
    expect(cleared.counterAmount).toBeUndefined();
    expect(cleared.counteredAt).toBeUndefined();
    expect(cleared.status).toBe("sent");

    // Replay 409s — the round ended.
    const again = await withdrawCounter(
      del({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(again.status).toBe(409);

    // But a withdrawn counter frees a NEW round: the buyer can counter
    // again (withdrew ≠ spent).
    const recounter = await counterQuote(
      post({ buyerEmail, token: rfq.accessToken, amount: 7500 }),
      params(quote.id),
    );
    expect(recounter.status).toBe(200);

    // Terminal rows refuse — a withdraw on an accepted quote is a ghost.
    await acceptQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    const dead = await withdrawCounter(
      del({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(dead.status).toBe(409);
  });
});

describe("POST /api/quotes/[id]/accept-counter (operator, QA-515)", () => {
  it("closes the deal at the buyer's counter; guards the whole way", async () => {
    const repo = await getMemoryRepo();
    const { opUser, otherUser, quote, buyerEmail, rfq } =
      await fixture(repo);

    // Anonymous + wrong operator + no-counter-on-table all refuse first.
    const anon = await acceptCounter(post(), params(quote.id));
    expect(anon.status).toBe(401);
    asUser(otherUser.id);
    const wrong = await acceptCounter(post(), params(quote.id));
    expect(wrong.status).toBe(403);
    asUser(opUser.id);
    const noCounter = await acceptCounter(post(), params(quote.id));
    expect(noCounter.status).toBe(409);

    // Buyer counters 8000 on the 9000 ask.
    const cnt = await counterQuote(
      post({ buyerEmail, token: rfq.accessToken, amount: 8000 }),
      params(quote.id),
    );
    expect(cnt.status).toBe(200);

    const res = await acceptCounter(post(), params(quote.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      quote: Quote;
      deal: { amount: number; currency: string; operatorId: string };
    };
    expect(body.quote.status).toBe("accepted");
    // The deal minted at THEIR number — not the original ask.
    expect(body.deal.amount).toBe(8000);
    expect(body.deal.operatorId).toBe((await repo.getQuote(quote.id))!.operatorId);
    expect((await repo.getRfq(rfq.id))!.status).toBe("closed");

    // Replay + buyer's own accept on the closed RFQ both 409.
    const again = await acceptCounter(post(), params(quote.id));
    expect(again.status).toBe(409);
    const lateBuyer = await acceptQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(lateBuyer.status).toBe(409);
  });
});

describe("POST /api/quotes/[id]/decline-counter (operator, QA-519)", () => {
  it("clears the counter without spending the round; guards the whole way", async () => {
    const repo = await getMemoryRepo();
    const { opUser, otherUser, quote, buyerEmail, rfq } =
      await fixture(repo);

    // Anonymous + wrong operator + no-counter-on-table all refuse first.
    const anon = await declineCounter(post(), params(quote.id));
    expect(anon.status).toBe(401);
    asUser(otherUser.id);
    const wrong = await declineCounter(post(), params(quote.id));
    expect(wrong.status).toBe(403);
    asUser(opUser.id);
    const noCounter = await declineCounter(post(), params(quote.id));
    expect(noCounter.status).toBe(409);

    // Buyer counters 8000 on the 9000 ask; the op says no.
    const cnt = await counterQuote(
      post({ buyerEmail, token: rfq.accessToken, amount: 8000 }),
      params(quote.id),
    );
    expect(cnt.status).toBe(200);

    const res = await declineCounter(post(), params(quote.id));
    expect(res.status).toBe(200);
    const after = (await res.json()) as Quote;
    // The quote still stands at the ask — nothing else moved.
    expect(after.status).toBe("sent");
    expect(after.amount).toBe(9000);
    expect(after.counterAmount).toBeUndefined();
    expect(after.counteredAt).toBeUndefined();
    // QA-522: the round persists in history as 'declined'.
    const rounds = await repo.listCounterRounds([quote.id]);
    expect(rounds.map((r) => r.outcome)).toEqual(["declined"]);
    expect(rounds[0]!.amount).toBe(8000);
    expect(rounds[0]!.resolvedAt).toBeDefined();

    // Replay 409s — the counter's gone — but a fresh round re-opens.
    const again = await declineCounter(post(), params(quote.id));
    expect(again.status).toBe(409);
    const recnt = await counterQuote(
      post({ buyerEmail, token: rfq.accessToken, amount: 8500 }),
      params(quote.id),
    );
    expect(recnt.status).toBe(200);
    expect((await repo.getQuote(quote.id))!.counterAmount).toBe(8500);

    // Once the quote leaves 'sent' there's nothing to decline.
    await repo.setQuoteStatus(quote.id, "withdrawn", "sent");
    const dead = await declineCounter(post(), params(quote.id));
    expect(dead.status).toBe(409);
  });
});

describe("POST /api/quotes/[id]/withdraw (operator)", () => {
  it("only the quote's operator may withdraw; replay 409", async () => {
    const repo = await getMemoryRepo();
    const { opUser, otherUser, quote } = await fixture(repo);

    const anon = await withdrawQuote(post(), params(quote.id));
    expect(anon.status).toBe(401);

    asUser(otherUser.id);
    const wrong = await withdrawQuote(post(), params(quote.id));
    expect(wrong.status).toBe(403);

    asUser(opUser.id);
    const res = await withdrawQuote(post(), params(quote.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Quote).status).toBe("withdrawn");

    const again = await withdrawQuote(post(), params(quote.id));
    expect(again.status).toBe(409);
  });
});

describe("POST /api/admin/deals/[id]/paid (admin)", () => {
  it("marks an invoiced deal paid, preserving invoiceRef; admin-only", async () => {
    const repo = await getMemoryRepo();
    const { opUser, quote, buyerEmail, rfq } = await fixture(repo);

    // Accept the quote to mint a deal; then force its invoice to invoiced.
    const acc = await acceptQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(acc.status).toBe(200);
    const { deal } = (await acc.json()) as { deal: { id: string } };
    await repo.setDealInvoice(deal.id, "invoiced", "inv_test_ref");

    asUser(opUser.id); // operator, not admin
    const denied = await markPaid(post(), params(deal.id));
    expect(denied.status).toBe(403);

    const admin = await repo.createUser("admin-lifecycle@test.dev", "admin");
    asUser(admin.id);
    const res = await markPaid(post(), params(deal.id));
    expect(res.status).toBe(200);
    const paid = (await res.json()) as { invoiceStatus: string; invoiceRef?: string };
    expect(paid.invoiceStatus).toBe("paid");
    expect(paid.invoiceRef).toBe("inv_test_ref");

    const again = await markPaid(post(), params(deal.id));
    expect(again.status).toBe(409);
  });
});

describe("POST /api/admin/listings/[id]/status (QA-157)", () => {
  it("is admin-only and only allows down-moderation states", async () => {
    const repo = await getMemoryRepo();
    const { opUser, listing } = await fixture(repo);

    asUser(opUser.id); // operator, not admin
    const denied = await moderateListing(
      post({ status: "paused" }),
      params(listing.id),
    );
    expect(denied.status).toBe(403);

    const admin = await repo.createUser("admin-mod@test.dev", "admin");
    asUser(admin.id);
    // `active` rejected — reactivation stays operator-owned (plan cap binds).
    const up = await moderateListing(
      post({ status: "active" }),
      params(listing.id),
    );
    expect(up.status).toBe(422);

    const res = await moderateListing(
      post({ status: "archived" }),
      params(listing.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("archived");
    expect((await repo.getListing(listing.id))?.status).toBe("archived");
  });
});

describe("POST /api/admin/rfqs/[id]/status (QA-181)", () => {
  it("is admin-only, spam-only, and refuses terminal RFQs", async () => {
    const repo = await getMemoryRepo();
    const { opUser, rfq } = await fixture(repo);

    asUser(opUser.id); // operator, not admin
    const denied = await moderateRfq(post({ status: "spam" }), params(rfq.id));
    expect(denied.status).toBe(403);

    const admin = await repo.createUser(`admin-rfq-${rfq.id.slice(0, 6)}@test.dev`, "admin");
    asUser(admin.id);
    // Only 'spam' is a valid moderation target.
    const invalid = await moderateRfq(
      post({ status: "closed" }),
      params(rfq.id),
    );
    expect(invalid.status).toBe(422);

    const res = await moderateRfq(post({ status: "spam" }), params(rfq.id));
    expect(res.status).toBe(200);
    expect((await repo.getRfq(rfq.id))?.status).toBe("spam");

    // Terminal rows refuse the flip — spam is terminal too.
    const again = await moderateRfq(post({ status: "spam" }), params(rfq.id));
    expect(again.status).toBe(409);
    // Missing id -> 404.
    const missing = await moderateRfq(
      post({ status: "spam" }),
      params("00000000-0000-0000-0000-000000000000"),
    );
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/rfqs/[id]/close (QA-182)", () => {
  it("buyer-token closes the RFQ and declines sent quotes; wrong token 404s", async () => {
    const repo = await getMemoryRepo();
    const { rfq, quote, buyerEmail } = await fixture(repo);

    const bad = await closeRfq(
      post({ buyerEmail, token: "wrong-token" }),
      params(rfq.id),
    );
    expect(bad.status).toBe(404);
    // fixture's createQuote already moved the RFQ open → quoted (live).
    expect((await repo.getRfq(rfq.id))?.status).toBe("quoted");

    const res = await closeRfq(
      post({ buyerEmail, token: rfq.accessToken }),
      params(rfq.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; declined: number };
    expect(body.status).toBe("closed");
    expect(body.declined).toBe(1);
    expect((await repo.getRfq(rfq.id))?.status).toBe("closed");
    expect((await repo.listQuotes({ rfqId: rfq.id }))[0]?.status).toBe(
      "declined",
    );

    // Terminal now — replay 409s and a late accept can't mint a deal.
    const again = await closeRfq(
      post({ buyerEmail, token: rfq.accessToken }),
      params(rfq.id),
    );
    expect(again.status).toBe(409);
    const lateAccept = await acceptQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(lateAccept.status).toBe(409);
  });
});

describe("POST /api/quotes/[id]/accept transient deal failure (QA-310)", () => {
  it("rolls the CAS flips back so a buyer retry still completes", async () => {
    const repo = await getMemoryRepo();
    const { rfq, quote, buyerEmail, otherOp } = await fixture(repo);
    // A second live quote on the same RFQ — QA-392: the rollback path must
    // leave it 'sent'. Declines run only after the deal exists, so a
    // transient failure can't orphan a sibling (and its operator doesn't
    // get a phantom "not selected" email for a deal that never minted).
    const sibling = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: otherOp.id,
      amount: 8000,
      currency: "USD",
      message: "",
    });

    const spy = vi
      .spyOn(repo, "createDeal")
      .mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      acceptQuote(
        post({ buyerEmail, token: rfq.accessToken }),
        params(quote.id),
      ),
    ).rejects.toThrow("connection reset");
    spy.mockRestore();

    // Neither CAS leaked: the RFQ is live again and the quote is back to
    // 'sent', so the retry takes the normal path instead of a dead 409.
    expect((await repo.getRfq(rfq.id))?.status).toBe("quoted");
    expect((await repo.getQuote(quote.id))?.status).toBe("sent");
    expect((await repo.getQuote(sibling.id))?.status).toBe("sent");

    const retry = await acceptQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(retry.status).toBe(200);
    expect((await repo.getQuote(quote.id))?.status).toBe("accepted");
    expect((await repo.getRfq(rfq.id))?.status).toBe("closed");
    // Post-deal decline loop: the sibling is declined exactly once, now that
    // the deal actually exists.
    expect((await repo.getQuote(sibling.id))?.status).toBe("declined");
  });
});

describe("POST /api/quotes expired-listing owner gate (QA-504)", () => {
  it("the owner can't quote their expired leg; a fan-out op still can", async () => {
    const repo = await getMemoryRepo();
    const tag = Math.random().toString(36).slice(2, 8);
    const opUser = await repo.createUser(`op-${tag}@test.dev`, "operator");
    const op = await repo.upsertOperator({
      userId: opUser.id,
      name: `Owner ${tag}`,
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    const otherUser = await repo.createUser(`op2-${tag}@test.dev`, "operator");
    const otherOp = await repo.upsertOperator({
      userId: otherUser.id,
      name: `Other ${tag}`,
      baseAirport: "GVA",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    // The leg's date already passed — read-time expired (QA-220).
    const listing = await repo.createListing({
      operatorId: op.id,
      vertical: "jets",
      type: "empty_leg",
      title: `Expired Leg ${tag}`,
      price: 5000,
      currency: "USD",
      photos: [],
      attributes: { date: "2020-01-01" },
    });
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: `b-${tag}@test.dev`,
      fields: {},
    });
    // Fan-out visibility for the other operator — they're a matched bidder,
    // not the listing owner.
    await repo.createRfqMatches([{ rfqId: rfq.id, operatorId: otherOp.id }]);

    asUser(opUser.id);
    const own = await createQuote(
      post({ rfqId: rfq.id, amount: 5000 }),
    );
    expect(own.status).toBe(409);
    expect(await repo.listQuotes({ rfqId: rfq.id })).toHaveLength(0);

    asUser(otherUser.id);
    const fanout = await createQuote(
      post({ rfqId: rfq.id, amount: 5100 }),
    );
    expect(fanout.status).toBe(201);
    asUser(null);
  });

  it("owner quotes on a re-dated leg work again", async () => {
    const repo = await getMemoryRepo();
    const tag = Math.random().toString(36).slice(2, 8);
    const opUser = await repo.createUser(`op-${tag}@test.dev`, "operator");
    const op = await repo.upsertOperator({
      userId: opUser.id,
      name: `Owner ${tag}`,
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    const listing = await repo.createListing({
      operatorId: op.id,
      vertical: "jets",
      type: "empty_leg",
      title: `Future Leg ${tag}`,
      price: 5000,
      currency: "USD",
      photos: [],
      attributes: { date: "2999-01-01" },
    });
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: `b-${tag}@test.dev`,
      fields: {},
    });
    asUser(opUser.id);
    const res = await createQuote(
      post({ rfqId: rfq.id, amount: 5000 }),
    );
    expect(res.status).toBe(201);
    asUser(null);
  });
});
