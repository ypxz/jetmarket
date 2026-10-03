import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { email } from "@jetmarket/providers";
import { MockAnalyticsProvider } from "@jetmarket/providers/analytics";

// Mock email provider writes to a per-suite outbox dir (QA-158 assertion).
const outboxDir = mkdtempSync(join(tmpdir(), "jm-analytics-outbox-"));
process.env.EMAIL_OUTBOX_DIR = outboxDir;

// RFQ windows must stay in the future — a past dateTo is expired by the
// memory-mode lazy sweep on subsequent route calls (QA-360).
const isoIn = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

// Operator session + analytics sink, shared by the route-handler tests below.
// The mock sink replaces the globalThis singleton so route imports can stay
// untouched.
const h = vi.hoisted(() => ({ userId: "" }));
const sink = new MockAnalyticsProvider({ log: false });
(globalThis as { __jmAnalytics?: unknown }).__jmAnalytics = sink;

vi.mock("next/headers", async () => {
  // Can't import @/lib/auth here — it itself imports next/headers and would
  // deadlock on this factory. signSession is just an HMAC; replicate it.
  const { createHmac } = await import("node:crypto");
  // Sessions embed the user's session_version (QA-108); every user this test
  // creates is fresh — version 1.
  const sig = (id: string, iat: number, ver: number) =>
    createHmac("sha256", process.env.SESSION_SECRET ?? "dev-only-not-a-secret")
      .update(`s:${id}.${iat}.${ver}`)
      .digest("hex");
  const sessionToken = (id: string) => {
    const iat = Date.now();
    return `${id}.${iat}.1.${sig(id, iat, 1)}`;
  };
  return {
    cookies: async () => ({
      get: (name: string) =>
        name === "jm_session" && h.userId
          ? { value: sessionToken(h.userId) }
          : undefined,
      set() {},
      delete() {},
    }),
  };
});

vi.mock("@/lib/outbox", () => ({ sendMail: async () => {} }));

import { getRepo } from "@/lib/repo";
import { applyPaymentEvent } from "@/lib/billing";
import { POST as postRfq } from "@/app/api/rfqs/route";
import { POST as buyerAccess } from "@/app/api/buyer/access/route";
import { POST as postListing } from "@/app/api/listings/route";
import { POST as postQuote } from "@/app/api/quotes/route";
import { POST as postAccept } from "@/app/api/quotes/[id]/accept/route";

const jsonReq = (body: unknown, ip = "198.51.100.77") =>
  new Request("http://test/api", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

describe("analytics events on money routes (mock sink)", async () => {
  const repo = await getRepo();
  // Seeded operator + one of its listings (memory seed: ops@alpine-air.example
  // is pro so the free-listing limit never bites). Pinned by plan — list order
  // is createdAt desc since QA-317, so [0] is no longer the first seed.
  const op = (await repo.listOperators()).find((o) => o.plan === "pro");
  const user = await repo.getUser(op!.userId);
  beforeAll(() => {
    h.userId = user!.id;
  });
  const listing = (await repo.listListings({ operatorId: op!.id }))[0]!;
  const events = (name: string) => sink.events.filter((e) => e.name === name);

  it("rfqs POST emits rfq_created with ids + vertical", async () => {
    const res = await postRfq(
      jsonReq({
        listingId: listing.id,
        buyerEmail: "buyer@x.example",
        fields: {
          departure: "ZRH",
          arrival: "NCE",
          dateFrom: isoIn(14),
          dateTo: isoIn(16),
          passengers: 4,
          name: "E2E Buyer",
          email: "buyer@x.example",
        },
      }),
    );
    expect(res.status).toBe(201);
    const [e] = events("rfq_created").slice(-1);
    expect(e?.props?.listingId).toBe(listing.id);
    expect(e?.props?.vertical).toBe("jets");
    expect(String(e?.props?.rfqId)).toMatch(/^rfq_/);

    // QA-158: the buyer gets a durable copy of their inbox link — the POST
    // response is the only other carrier and is lossy.
    const mails = email.readOutbox(outboxDir);
    const confirm = mails.find((m) => m.to === "buyer@x.example");
    expect(confirm).toBeTruthy();
    expect(confirm!.text).toContain("/quotes?");
    expect(confirm!.text).toContain("t=");
    // Concierge upsell rides the same mail — deep link to the thanks-page
    // card, bearer token in the fragment (never the query).
    expect(confirm!.text).toContain("/rfq/thanks?id=");
    expect(confirm!.text).toContain("$49");
    expect(confirm!.text).toContain("#t=");
    // Submitted fields stay out of the confirmation (bogus-address safety).
    expect(confirm!.text).not.toContain("E2E Buyer");
  });

  it("buyer/access re-emails the bearer links and never enumerates (QA-160)", async () => {
    const res = await buyerAccess(
      jsonReq({ email: "buyer@x.example" }, "198.51.100.78"),
    );
    expect(res.status).toBe(200);
    const mail = email
      .readOutbox(outboxDir)
      .filter((m) => m.to === "buyer@x.example" && m.subject?.includes("quote links"))
      .pop();
    expect(mail).toBeTruthy();
    expect(mail!.text).toContain("/quotes?");
    expect(mail!.text).toContain("t=");

    // Unknown inbox: same 200 shape, no mail.
    const before = email
      .readOutbox(outboxDir)
      .filter((m) => m.to === "nobody@x.example").length;
    const res2 = await buyerAccess(
      jsonReq({ email: "nobody@x.example" }, "198.51.100.78"),
    );
    expect(res2.status).toBe(200);
    expect(
      email
        .readOutbox(outboxDir)
        .filter((m) => m.to === "nobody@x.example").length,
    ).toBe(before);
  });

  it("listings POST rejects a currency that isn't the vertical's (QA-185)", async () => {
    const bad = await postListing(
      jsonReq({
        type: "charter",
        title: "EUR-priced listing in USD pool",
        price: 500,
        currency: "EUR",
        attributes: {},
      }),
    );
    expect(bad.status).toBe(422);
    // Omitted currency defaults to the vertical's own.
    const ok = await postListing(
      jsonReq({
        type: "charter",
        title: "Default-currency charter",
        price: 500,
        attributes: {},
      }),
    );
    expect(ok.status).toBe(201);
    expect((await ok.json()).currency).toBe("USD");
  });

  it("listings POST emits listing_created", async () => {
    const res = await postListing(
      jsonReq({
        type: "charter",
        title: "Analytics test charter",
        price: 1000,
        attributes: { model: "X" },
      }),
    );
    expect(res.status).toBe(201);
    const [e] = events("listing_created").slice(-1);
    expect(e?.props?.type).toBe("charter");
    expect(e?.props?.vertical).toBe("jets");
    expect(String(e?.props?.listingId)).toMatch(/^lst_/);
  });

  it("quotes POST emits quote_sent with amount", async () => {
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: "buyer2@x.example",
      fields: {},
    });
    const res = await postQuote(jsonReq({ rfqId: rfq.id, amount: 5000 }));
    expect(res.status).toBe(201);
    const [e] = events("quote_sent").slice(-1);
    expect(e?.props?.rfqId).toBe(rfq.id);
    expect(e?.props?.amount).toBe(5000);
    expect(e?.props?.currency).toBe("USD");
  });

  it("quote accept emits quote_accepted then deal_closed", async () => {
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: "buyer3@x.example",
      fields: {},
    });
    const quote = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: op!.id,
      amount: 9000,
      currency: "USD",
      message: "",
    });
    const before = sink.events.length;
    const res = await postAccept(
      jsonReq({ buyerEmail: "buyer3@x.example", token: rfq.accessToken }),
      {
      params: Promise.resolve({ id: quote.id }),
    });
    expect(res.status).toBe(200);
    const newEvents = sink.events.slice(before).map((e) => e.name);
    expect(newEvents).toEqual(["quote_accepted", "deal_closed"]);
    const deal = events("deal_closed").slice(-1)[0]!;
    expect(deal.props?.quoteId).toBe(quote.id);
    expect(Number(deal.props?.feeAmount)).toBeCloseTo(270); // 3% charter fee
  });

  it("billing events emit plan_upgraded/plan_downgraded (QA-187)", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    const before = sink.events.length;
    await applyPaymentEvent(repo, {
      kind: "subscription.activated",
      customerId: op!.id,
      subscriptionId: "sub_test1",
      created: t0,
      metadata: { operatorId: op!.id, plan: "pro" },
    });
    await applyPaymentEvent(repo, {
      kind: "subscription.canceled",
      customerId: op!.id,
      subscriptionId: "sub_test1",
      created: t0 + 1,
      metadata: { operatorId: op!.id },
    });
    const names = sink.events.slice(before).map((e) => e.name);
    expect(names).toEqual(["plan_upgraded", "plan_downgraded"]);
    expect(sink.events[before]!.props?.operatorId).toBe(op!.id);
    // Restore the seeded pro plan so later suites' listing caps don't bite.
    await applyPaymentEvent(repo, {
      kind: "subscription.activated",
      customerId: op!.id,
      subscriptionId: "sub_test1",
      created: t0 + 2,
      metadata: { operatorId: op!.id, plan: "pro" },
    });
  });
});
