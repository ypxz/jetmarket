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
import { POST as withdrawQuote } from "../../app/api/quotes/[id]/withdraw/route";
import { POST as markPaid } from "../../app/api/admin/deals/[id]/paid/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://test.local/api", {
    method: "POST",
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

const asUser = (id: string | null) =>
  id
    ? jar.set(sessionCookie, signSession(id))
    : jar.delete(sessionCookie);

beforeEach(() => jar.clear());

describe("POST /api/quotes/[id]/decline (buyer)", () => {
  it("declines a sent quote for its buyer; wrong email 403; replay 409", async () => {
    const repo = await getMemoryRepo();
    const { quote, buyerEmail } = await fixture(repo);

    const bad = await declineQuote(post({ buyerEmail: "nope@x.dev" }), params(quote.id));
    expect(bad.status).toBe(403);

    const res = await declineQuote(post({ buyerEmail }), params(quote.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Quote).status).toBe("declined");
    expect((await repo.getQuote(quote.id))?.status).toBe("declined");

    const again = await declineQuote(post({ buyerEmail }), params(quote.id));
    expect(again.status).toBe(409);
  });

  it("404s on unknown quote", async () => {
    const res = await declineQuote(
      post({ buyerEmail: "b@x.dev" }),
      params("quo_missing"),
    );
    expect(res.status).toBe(404);
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
    const { opUser, quote, buyerEmail } = await fixture(repo);

    // Accept the quote to mint a deal; then force its invoice to invoiced.
    const acc = await acceptQuote(post({ buyerEmail }), params(quote.id));
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
