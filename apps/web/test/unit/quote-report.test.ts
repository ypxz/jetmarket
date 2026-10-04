/**
 * QA-529: buyer quote-report route + repo dedupe against the memory impl.
 * Mailbox proof is the same dual session/bearer token every buyer quote
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
import { POST as reportQuote } from "../../app/api/quotes/[id]/report/route";
import { POST as dismissQuoteReport } from "../../app/api/admin/quote-reports/[id]/dismiss/route";
import { sessionCookie, signSession } from "../../lib/auth";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://test.local/api/quotes/x/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });

async function fixture(repo: Repo) {
  const tag = Math.random().toString(36).slice(2, 8);
  const buyerEmail = `rep-b-${tag}@test.dev`;
  const opUser = await repo.createUser(`rep-o-${tag}@test.dev`, "operator");
  const op = await repo.upsertOperator({
    userId: opUser.id,
    name: `Rep Ops ${tag}`,
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
  const admin = await repo.createUser(`rep-a-${tag}@test.dev`, "admin");
  return { buyerEmail, rfq, quote, op, admin };
}

describe("QA-529: buyer quote reports", () => {
  beforeEach(() => jar.clear());

  it("files once, dedupes to 409, rejects wrong mailbox/wrong token/foreign rfq", async () => {
    const repo = await getMemoryRepo();
    const { buyerEmail, rfq, quote } = await fixture(repo);

    // Validation: bad email, unknown reason, oversized note → 422 before
    // any repo work.
    for (const body of [
      { buyerEmail: "nope", token: rfq.accessToken, reason: "scam" },
      { buyerEmail, token: rfq.accessToken, reason: "political" },
      { buyerEmail, token: rfq.accessToken, reason: "scam", note: "x".repeat(501) },
    ]) {
      const res = await reportQuote(post(body), params(quote.id));
      expect(res.status).toBe(422);
    }

    // Wrong mailbox + right token → 403; right mailbox + wrong token → 403.
    expect(
      (await reportQuote(
        post({ buyerEmail: "nope@x.dev", token: rfq.accessToken, reason: "scam" }),
        params(quote.id),
      )).status,
    ).toBe(403);
    expect(
      (await reportQuote(
        post({ buyerEmail, token: "bogus", reason: "scam" }),
        params(quote.id),
      )).status,
    ).toBe(403);
    // Unknown quote → 404 (before auth — same as accept/decline).
    expect(
      (await reportQuote(
        post({ buyerEmail, token: rfq.accessToken, reason: "scam" }),
        params("quote-missing"),
      )).status,
    ).toBe(404);

    // Happy path: bearer-token mailbox proof files the flag once; the
    // same address re-flagging the same open quote dedupes to 409.
    const res = await reportQuote(
      post({
        buyerEmail,
        token: rfq.accessToken,
        reason: "off_platform",
        note: "asked to move to WhatsApp",
      }),
      params(quote.id),
    );
    expect(res.status).toBe(201);
    const report = await res.json();
    expect(report.status).toBe("open");
    expect(report.reporterEmail).toBe(buyerEmail);
    expect(report.reason).toBe("off_platform");
    expect(
      (await reportQuote(
        post({ buyerEmail, token: rfq.accessToken, reason: "scam" }),
        params(quote.id),
      )).status,
    ).toBe(409);
  });

  it("blocked address 403s; admin session dismisses once then 409s", async () => {
    const repo = await getMemoryRepo();
    const { buyerEmail, rfq, quote, op, admin } = await fixture(repo);

    // File the flag first via the bearer path.
    const filed = await (
      await reportQuote(
        post({ buyerEmail, token: rfq.accessToken, reason: "spam" }),
        params(quote.id),
      )
    ).json();

    // No admin session → 403 (requireUser(null) — admin-only gate).
    expect(
      (await dismissQuoteReport(post(), params(filed.id))).status,
    ).toBe(403);

    // Admin session → 200 once, 409 on replay, 409 on unknown id (the
    // CAS can't distinguish missing from already-dismissed).
    jar.set(sessionCookie, signSession(admin.id, 1));
    const d1 = await dismissQuoteReport(post(), params(filed.id));
    expect(d1.status).toBe(200);
    expect((await dismissQuoteReport(post(), params(filed.id))).status).toBe(409);
    expect((await dismissQuoteReport(post(), params("rep-missing"))).status).toBe(409);
    jar.clear();

    // The blocked address now hits isEmailBlocked → 403 (the earlier flag
    // is dismissed so the dedupe can't mask this check).
    await repo.blockBuyerEmail(buyerEmail, { reason: "spam burst" });
    const rfq2 = await repo.createRfq({
      vertical: "jets",
      listingId: null,
      buyerEmail,
      fields: {},
    });
    const quote2 = await repo.createQuote({
      rfqId: rfq2.id,
      operatorId: op.id,
      amount: 9000,
      currency: "USD",
      message: "",
    });
    expect(
      (await reportQuote(
        post({ buyerEmail, token: rfq2.accessToken, reason: "other" }),
        params(quote2.id),
      )).status,
    ).toBe(403);
  });
});
