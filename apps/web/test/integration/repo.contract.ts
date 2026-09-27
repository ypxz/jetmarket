/**
 * Shared Repo contract suite — run the same assertions against every Repo
 * implementation (memory, drizzle) so behavior can't drift between backends.
 */
import { describe, expect, it } from "vitest";
import type { Repo } from "../../lib/repo/types";

export function repoContract(
  name: string,
  factory: () => Promise<Repo>,
): void {
  describe(`Repo contract (${name})`, () => {
    it("walks the core loop: user → operator → listing → rfq → quote → deal", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);

      const user = await repo.createUser(`op-${tag}@test.dev`, "operator");
      expect(user.id).toBeTruthy();
      expect(await repo.findUserByEmail(user.email)).toMatchObject({
        id: user.id,
      });
      expect(await repo.getUser(user.id)).toMatchObject({ email: user.email });
      expect(await repo.getUser("missing")).toBeUndefined();

      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Contract Air",
        baseAirport: "ZRH",
        fleetSummary: "2x Phenom 300",
        verified: false,
        plan: "free",
      });
      expect(op.plan).toBe("free");
      expect(await repo.getOperatorByUserId(user.id)).toMatchObject({
        id: op.id,
      });

      const listing = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `Contract Jet ${tag}`,
        price: 9000,
        currency: "USD",
        photos: [],
        attributes: { aircraftCategory: "light", seats: 6 },
      });
      expect(listing.status).toBe("active");
      expect(await repo.getListing(listing.id)).toMatchObject({
        operatorId: op.id,
      });
      expect(await repo.countOperatorListings(op.id)).toBe(1);

      const rfq = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `buyer-${tag}@test.dev`,
        fields: {
          departure: "ZRH",
          arrival: "NCE",
          dateFrom: "2026-10-01",
          dateTo: "2026-10-03",
          passengers: 2,
          name: "B Uyer",
          email: `buyer-${tag}@test.dev`,
        },
      });
      expect(rfq.status).toBe("open");
      expect(rfq.accessToken).toBeTruthy();
      expect(await repo.listRfqs({ operatorId: op.id })).toHaveLength(1);
      expect(await repo.countRfqs({ operatorId: op.id })).toBe(1);
      expect(
        await repo.listRfqs({ buyerEmail: `buyer-${tag}@test.dev` }),
      ).toHaveLength(1);
      expect(
        await repo.countRfqs({ buyerEmail: `buyer-${tag}@test.dev` }),
      ).toBe(1);
      // limit/offset slice, newest-first ordering preserved.
      expect(
        await repo.listRfqs({ operatorId: op.id, limit: 1, offset: 0 }),
      ).toHaveLength(1);
      expect(
        await repo.listRfqs({ operatorId: op.id, limit: 1, offset: 1 }),
      ).toHaveLength(0);

      const quote = await repo.createQuote({
        rfqId: rfq.id,
        operatorId: op.id,
        amount: 20000,
        currency: "USD",
        message: "all-in",
      });
      expect(await repo.listQuotes({ rfqId: rfq.id })).toHaveLength(1);
      // Creating a quote moves the RFQ open → quoted.
      expect((await repo.getRfq(rfq.id))?.status).toBe("quoted");

      await repo.setQuoteStatus(quote.id, "accepted");
      expect((await repo.getQuote(quote.id))?.status).toBe("accepted");

      const deal = await repo.createDeal({
        quoteId: quote.id,
        operatorId: op.id,
        amount: 20000,
        feePct: 0.03,
        feeAmount: 600,
        invoiceStatus: "pending",
      });
      expect(deal.quoteId).toBe(quote.id);
      expect(await repo.listDeals({ operatorId: op.id })).toHaveLength(1);
    });

    it("enforces plan listing counts and subscription round-trips", async () => {
      const repo = await factory();
      const user = await repo.createUser(
        `plan-${Date.now().toString(36)}@test.dev`,
        "operator",
      );
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Plan Air",
        baseAirport: "GVA",
        fleetSummary: "",
        verified: false,
        plan: "free",
      });
      for (let i = 0; i < 4; i++) {
        await repo.createListing({
          operatorId: op.id,
          vertical: "jets",
          type: "charter",
          title: `Plan Jet ${i}`,
          price: 1000 + i,
          currency: "USD",
          photos: [],
          attributes: {},
        });
      }
      expect(await repo.countOperatorListings(op.id)).toBe(4);

      const sub = await repo.upsertSubscription({
        operatorId: op.id,
        plan: "pro",
        status: "active",
        currentPeriodEnd: "2026-10-15T00:00:00.000Z",
      });
      expect(sub.plan).toBe("pro");
      expect(await repo.getSubscription(op.id)).toMatchObject({
        plan: "pro",
        status: "active",
      });

      await repo.setOperatorPlan(op.id, "pro");
      expect((await repo.getOperator(op.id))?.plan).toBe("pro");
      await repo.setOperatorVerified(op.id, true);
      expect((await repo.getOperator(op.id))?.verified).toBe(true);
    });

    it("stale-webhook gate: older event stamps never clobber the sub", async () => {
      const repo = await factory();
      const tag = `stale${Date.now().toString(36)}`;
      const user = await repo.createUser(`${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Stale Air",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      const fresh = await repo.upsertSubscription({
        operatorId: op.id,
        plan: "pro",
        status: "active",
        currentPeriodEnd: "2026-10-15T00:00:00.000Z",
        lastEventAt: 2000,
      });
      expect(fresh.status).toBe("active");
      // a stale stamped write (e.g. late "canceled") is a no-op
      const stale = await repo.upsertSubscription({
        operatorId: op.id,
        plan: "free",
        status: "canceled",
        currentPeriodEnd: "2026-09-15T00:00:00.000Z",
        lastEventAt: 1999,
      });
      expect(stale.status).toBe("active");
      expect((await repo.getSubscription(op.id))?.status).toBe("active");
      // unstamped writes (mock checkout) always apply
      const unstamped = await repo.upsertSubscription({
        operatorId: op.id,
        plan: "pro",
        status: "canceled",
        currentPeriodEnd: "2026-09-20T00:00:00.000Z",
      });
      expect(unstamped.status).toBe("canceled");
    });

    it("filters listings by status/vertical/type/facets/query", async () => {
      const repo = await factory();
      const tag = `flt${Date.now().toString(36)}`;
      const user = await repo.createUser(`${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Filter Air",
        baseAirport: "LTN",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      const a = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "empty_leg",
        title: `${tag} ZRH to NCE`,
        price: 4200,
        currency: "USD",
        photos: [],
        attributes: { aircraftCategory: "light", from: "ZRH", to: "NCE" },
      });
      const b = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "aircraft_sale",
        title: `${tag} G650 for sale`,
        price: 40000000,
        currency: "USD",
        photos: [],
        attributes: { aircraftCategory: "ultra_long" },
      });
      await repo.updateListingStatus(a.id, "archived");

      const mine = await repo.listListings({
        operatorId: op.id,
        status: "active",
      });
      expect(mine.map((l) => l.id)).not.toContain(a.id);

      const legs = await repo.listListings({
        operatorId: op.id,
        status: "active",
        type: "empty_leg",
      });
      expect(legs).toHaveLength(0); // the only leg is archived

      await repo.updateListing(b.id, {
        title: `${tag} G650 for sale — reduced`,
        price: 38000000,
        attributes: { aircraftCategory: "ultra_long", year: 2021 },
      });
      expect(await repo.getListing(b.id)).toMatchObject({
        title: `${tag} G650 for sale — reduced`,
        price: 38000000,
        attributes: { aircraftCategory: "ultra_long", year: 2021 },
      });

      const faceted = await repo.listListings({
        operatorId: op.id,
        facets: { aircraftCategory: "ultra_long" },
      });
      expect(faceted.map((l) => l.title)).toEqual([
        `${tag} G650 for sale — reduced`,
      ]);

      const queried = await repo.listListings({
        operatorId: op.id,
        query: "g650",
      });
      expect(queried.map((l) => l.title)).toEqual([
        `${tag} G650 for sale — reduced`,
      ]);
    });

    it("paginates listings with limit/offset and countListings", async () => {
      const repo = await factory();
      const tag = `pg${Date.now().toString(36)}`;
      const user = await repo.createUser(`${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Page Air",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      for (let i = 0; i < 5; i++) {
        await repo.createListing({
          operatorId: op.id,
          vertical: "jets",
          type: "charter",
          title: `${tag} page-${i}`,
          price: 1000 + i,
          currency: "USD",
          photos: [],
          attributes: {
            aircraftCategory: "light",
            seats: i < 2 ? "8" : "5",
            model: "Phenom 300",
          },
        });
        await new Promise((r) => setTimeout(r, 5));
      }
      const base = { operatorId: op.id };
      const total = await repo.countListings(base);
      const all = await repo.listListings(base);
      expect(total).toBe(all.length);
      const page1 = await repo.listListings({ ...base, limit: 2, offset: 0 });
      const page2 = await repo.listListings({ ...base, limit: 2, offset: 2 });
      expect(page1.map((l) => l.id)).toEqual(all.slice(0, 2).map((l) => l.id));
      expect(page2.map((l) => l.id)).toEqual(all.slice(2, 4).map((l) => l.id));
      expect(page1).not.toEqual(page2);
      // facets + limit: the page must come from the facet-filtered set
      const faceted = await repo.listListings({
        ...base,
        facets: { aircraftCategory: "nope" },
        limit: 2,
      });
      expect(faceted).toHaveLength(0);
      expect(
        await repo.countListings({ ...base, facets: { aircraftCategory: "nope" } }),
      ).toBe(0);
      // facetRanges: attribute (seats) + builtin price, count + slice agree
      const ranged = await repo.listListings({
        ...base,
        facetRanges: [{ key: "price", min: 1001, max: 1003 }],
      });
      expect(ranged.map((l) => l.price)).toEqual([1003, 1002, 1001]);
      expect(
        await repo.countListings({
          ...base,
          facetRanges: [{ key: "price", min: 1001, max: 1003 }],
        }),
      ).toBe(3);
      const attrRange = await repo.listListings({
        ...base,
        facetRanges: [{ key: "seats", min: 7 }],
      });
      expect(attrRange).toHaveLength(2);
      // non-numeric attribute value never satisfies a range
      expect(
        await repo.countListings({
          ...base,
          facetRanges: [{ key: "model", min: 0 }],
        }),
      ).toBe(0);
    });

    it("returns listings newest-first (memory matches drizzle order)", async () => {
      const repo = await factory();
      const tag = `ord${Date.now().toString(36)}`;
      const user = await repo.createUser(`${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Order Air",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      const mk = (title: string) =>
        repo.createListing({
          operatorId: op.id,
          vertical: "jets",
          type: "charter",
          title,
          price: 1000,
          currency: "USD",
          photos: [],
          attributes: { aircraftCategory: "light" },
        });
      await mk(`${tag} first`);
      // createdAt is millisecond-precision in memory — a gap keeps the
      // ordering assertion deterministic on both backends.
      await new Promise((r) => setTimeout(r, 10));
      await mk(`${tag} second`);

      const rows = await repo.listListings({ operatorId: op.id });
      expect(rows.map((l) => l.title).slice(0, 2)).toEqual([
        `${tag} second`,
        `${tag} first`,
      ]);
    });

    it("sweeps expired rfqs: past dateTo -> expired/closed, sent quotes -> declined", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const user = await repo.createUser(`exp-${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Exp Air",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      const listing = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `Exp Jet ${tag}`,
        price: 5000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const stale = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `buyer-${tag}@test.dev`,
        fields: { dateTo: "2000-01-01" },
      });
      const fresh = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `buyer-${tag}@test.dev`,
        fields: { dateTo: "2999-01-01" },
      });
      const staleQuote = await repo.createQuote({
        rfqId: stale.id,
        operatorId: op.id,
        amount: 5000,
        currency: "USD",
        message: "",
      });
      const freshQuote = await repo.createQuote({
        rfqId: fresh.id,
        operatorId: op.id,
        amount: 6000,
        currency: "USD",
        message: "",
      });

      const res = await repo.expireRfqs(new Date().toISOString());
      expect(res).toEqual({ rfqs: 1, quotes: 1 });
      // iface "expired" maps to db "closed" — accept either terminal state.
      expect(["expired", "closed"]).toContain(
        (await repo.getRfq(stale.id))?.status,
      );
      expect((await repo.getRfq(fresh.id))?.status).toBe("quoted");
      expect((await repo.getQuote(staleQuote.id))?.status).toBe("declined");
      expect((await repo.getQuote(freshQuote.id))?.status).toBe("sent");
      // idempotent
      expect(await repo.expireRfqs(new Date().toISOString())).toEqual({
        rfqs: 0,
        quotes: 0,
      });
    });

    it("keeps invoiceRef across invoiceStatus transitions (invoiced -> paid)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const user = await repo.createUser(`inv-${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Inv Air",
        baseAirport: "GVA",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      const listing = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `Inv Jet ${tag}`,
        price: 5000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const rfq = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `b-${tag}@test.dev`,
        fields: {},
      });
      const quote = await repo.createQuote({
        rfqId: rfq.id,
        operatorId: op.id,
        amount: 5000,
        currency: "USD",
        message: "",
      });
      const deal = await repo.createDeal({
        quoteId: quote.id,
        operatorId: op.id,
        amount: 5000,
        feePct: 0.03,
        feeAmount: 150,
        invoiceStatus: "pending",
      });
      expect(await repo.getDeal(deal.id)).toMatchObject({
        invoiceStatus: "pending",
      });
      await repo.setDealInvoice(deal.id, "invoiced", "inv_test_1");
      await repo.setDealInvoice(deal.id, "paid"); // ref omitted -> preserved
      expect(await repo.getDeal(deal.id)).toMatchObject({
        invoiceStatus: "paid",
        invoiceRef: "inv_test_1",
      });
      // deals.quote_id is unique — a racing double-accept must be rejected.
      await expect(
        repo.createDeal({
          quoteId: quote.id,
          operatorId: op.id,
          amount: 5000,
          feePct: 0.03,
          feeAmount: 150,
          invoiceStatus: "pending",
        }),
      ).rejects.toThrow();
    });
  });
}
