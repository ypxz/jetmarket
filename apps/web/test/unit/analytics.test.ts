import { beforeAll, describe, expect, it, vi } from "vitest";
import { MockAnalyticsProvider } from "@jetmarket/providers/analytics";

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
  const sig = (id: string) =>
    createHmac("sha256", process.env.SESSION_SECRET ?? "dev-only-not-a-secret")
      .update(id)
      .digest("hex");
  return {
    cookies: async () => ({
      get: (name: string) =>
        name === "jm_session" && h.userId
          ? { value: `${h.userId}.${sig(h.userId)}` }
          : undefined,
      set() {},
      delete() {},
    }),
  };
});

vi.mock("@/lib/outbox", () => ({ sendMail: async () => {} }));

import { getRepo } from "@/lib/repo";
import { POST as postRfq } from "@/app/api/rfqs/route";
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
  // is pro so the free-listing limit never bites).
  const [op] = await repo.listOperators();
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
          dateFrom: "2026-10-01",
          dateTo: "2026-10-03",
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
    const res = await postAccept(jsonReq({ buyerEmail: "buyer3@x.example" }), {
      params: Promise.resolve({ id: quote.id }),
    });
    expect(res.status).toBe(200);
    const newEvents = sink.events.slice(before).map((e) => e.name);
    expect(newEvents).toEqual(["quote_accepted", "deal_closed"]);
    const deal = events("deal_closed").slice(-1)[0]!;
    expect(deal.props?.quoteId).toBe(quote.id);
    expect(Number(deal.props?.feeAmount)).toBeCloseTo(270); // 3% charter fee
  });
});
