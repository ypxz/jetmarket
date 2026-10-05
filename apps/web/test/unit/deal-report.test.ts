/**
 * QA-555: buyer deal-report route + repo dedupe against the memory impl.
 * Mailbox proof is the same dual session/bearer token every buyer deal
 * action uses; the admin dismiss CAS + reporter sweep ride the same file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import { getMemoryRepo } from "../../lib/repo/memory";
import type { Repo } from "../../lib/repo/types";
import { POST as reportDeal } from "../../app/api/deals/[id]/report/route";
import { POST as dismissDealReport } from "../../app/api/admin/deal-reports/[id]/dismiss/route";
import { sessionCookie, signSession } from "../../lib/auth";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://test.local/api/deals/x/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
const dismissReq = () =>
  new Request("http://test.local/api/admin/deal-reports/x/dismiss", {
    method: "POST",
  });

async function fixture(repo: Repo) {
  const tag = Math.random().toString(36).slice(2, 8);
  const buyerEmail = `drep-b-${tag}@test.dev`;
  const opUser = await repo.createUser(`drep-o-${tag}@test.dev`, "operator");
  const op = await repo.upsertOperator({
    userId: opUser.id,
    name: `DRep Ops ${tag}`,
    baseAirport: "ZRH",
    fleetSummary: "",
    verified: true,
    plan: "free",
  });
  const rfq = await repo.createRfq({
    vertical: "jets",
    listingId: null,
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
  const deal = await repo.createDeal({
    quoteId: quote.id,
    operatorId: op.id,
    amount: 8000,
    currency: "USD",
    feePct: 0.03,
    feeAmount: 240,
    invoiceStatus: "invoiced",
  });
  const admin = await repo.createUser(`drep-a-${tag}@test.dev`, "admin");
  return { buyerEmail, rfq, quote, deal, op, admin };
}

describe("QA-555: buyer deal reports", () => {
  beforeEach(() => jar.clear());

  it("files once, dedupes to 409, rejects wrong mailbox/wrong token/missing deal", async () => {
    const repo = await getMemoryRepo();
    const { buyerEmail, rfq, deal } = await fixture(repo);

    // Validation: bad email, unknown reason, oversized note → 422 before
    // any repo work.
    for (const body of [
      { buyerEmail: "nope", token: rfq.accessToken, reason: "scam" },
      { buyerEmail, token: rfq.accessToken, reason: "political" },
      { buyerEmail, token: rfq.accessToken, reason: "scam", note: "x".repeat(501) },
    ]) {
      const res = await reportDeal(post(body), params(deal.id));
      expect(res.status).toBe(422);
    }

    // Wrong mailbox + right token → 403; right mailbox + wrong token → 403.
    expect(
      (await reportDeal(
        post({ buyerEmail: "nope@x.dev", token: rfq.accessToken, reason: "scam" }),
        params(deal.id),
      )).status,
    ).toBe(403);
    expect(
      (await reportDeal(
        post({ buyerEmail, token: "bogus", reason: "scam" }),
        params(deal.id),
      )).status,
    ).toBe(403);
    // Unknown deal → 404 (before auth — same as the quote report route).
    expect(
      (await reportDeal(
        post({ buyerEmail, token: rfq.accessToken, reason: "scam" }),
        params("deal-missing"),
      )).status,
    ).toBe(404);

    // Happy path: bearer-token mailbox proof files the flag once; the
    // same address re-flagging the same deal dedupes to 409.
    const res = await reportDeal(
      post({
        buyerEmail,
        token: rfq.accessToken,
        reason: "no_service",
        note: "the plane never showed",
      }),
      params(deal.id),
    );
    expect(res.status).toBe(201);
    const report = await res.json();
    expect(report.status).toBe("open");
    expect(report.dealId).toBe(deal.id);
    expect(report.reporterEmail).toBe(buyerEmail);
    expect(report.reason).toBe("no_service");
    expect(
      (await reportDeal(
        post({ buyerEmail, token: rfq.accessToken, reason: "scam" }),
        params(deal.id),
      )).status,
    ).toBe(409);
  });

  it("blocked address 403s; admin session dismisses once then 409s; re-flag after dismiss", async () => {
    const repo = await getMemoryRepo();
    const { buyerEmail, rfq, deal, admin } = await fixture(repo);

    // File the flag first via the bearer path.
    const filed = await (
      await reportDeal(
        post({ buyerEmail, token: rfq.accessToken, reason: "no_service" }),
        params(deal.id),
      )
    ).json();

    // No admin session → 403 (requireUser(null) — admin-only gate).
    expect(
      (await dismissDealReport(dismissReq(), params(filed.id))).status,
    ).toBe(403);

    // Admin session → 200 once, 409 on replay, 409 on unknown id (the
    // CAS can't distinguish missing from already-dismissed).
    jar.set(sessionCookie, signSession(admin.id, 1));
    const d1 = await dismissDealReport(dismissReq(), params(filed.id));
    expect(d1.status).toBe(200);
    expect((await dismissDealReport(dismissReq(), params(filed.id))).status).toBe(409);
    expect((await dismissDealReport(dismissReq(), params("rep-missing"))).status).toBe(409);
    jar.clear();

    // A dismissed flag doesn't hold the dedupe — a fresh flag re-arms
    // (partial unique on status='open').
    const refiled = await reportDeal(
      post({ buyerEmail, token: rfq.accessToken, reason: "scam" }),
      params(deal.id),
    );
    expect(refiled.status).toBe(201);
    const rep2 = await refiled.json();
    expect(rep2.id).not.toBe(filed.id);
    expect(rep2.status).toBe("open");

    // The blocked address now hits isEmailBlocked → 403 (dismiss the
    // second flag first so the dedupe can't mask this check).
    jar.set(sessionCookie, signSession(admin.id, 1));
    await dismissDealReport(dismissReq(), params(rep2.id));
    jar.clear();
    await repo.blockBuyerEmail(buyerEmail, { reason: "spam burst" });
    expect(
      (await reportDeal(
        post({ buyerEmail, token: rfq.accessToken, reason: "other" }),
        params(deal.id),
      )).status,
    ).toBe(403);
  });
});
