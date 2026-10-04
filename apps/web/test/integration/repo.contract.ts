/**
 * Shared Repo contract suite — run the same assertions against every Repo
 * implementation (memory, drizzle) so behavior can't drift between backends.
 */
import { describe, expect, it } from "vitest";
import type { Repo } from "../../lib/repo/types";
import { isUniqueViolation } from "../../lib/api";

// RFQ windows must stay in the future — a past dateTo is expired by the
// lazy sweep on subsequent repo reads in memory mode (QA-360).
const isoIn = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

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
      // Per-vertical plan cap: a foreign-vertical listing must not consume
      // the count on a shared DB (QA-302).
      await repo.createListing({
        operatorId: op.id,
        vertical: "machinery",
        type: "for_sale",
        title: `Foreign ${tag}`,
        price: 5000,
        currency: "EUR",
        photos: [],
        attributes: {},
      });
      expect(await repo.countOperatorListings(op.id, "jets")).toBe(1);
      expect(await repo.countOperatorListings(op.id, "machinery")).toBe(1);
      expect(await repo.countOperatorListings(op.id)).toBe(2);
      expect(await repo.listListingCountsByOperator([op.id])).toEqual({
        [op.id]: 2,
      });
      expect(
        await repo.listListingCountsByOperator([op.id], "jets"),
      ).toEqual({ [op.id]: 1 });

      const rfq = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `buyer-${tag}@test.dev`,
        fields: {
          departure: "ZRH",
          arrival: "NCE",
          dateFrom: isoIn(14),
          dateTo: isoIn(16),
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
      // buyerEmail lookup is case-insensitive — stored lowercase at create,
      // buyer re-entry may differ in case (QA-153).
      expect(
        await repo.listRfqs({ buyerEmail: `BUYER-${tag}@TEST.DEV` }),
      ).toHaveLength(1);
      expect(
        await repo.countRfqs({ buyerEmail: `BUYER-${tag}@TEST.DEV` }),
      ).toBe(1);
      // limit/offset slice, newest-first ordering preserved.
      expect(
        await repo.listRfqs({ operatorId: op.id, limit: 1, offset: 0 }),
      ).toHaveLength(1);
      expect(
        await repo.listRfqs({ operatorId: op.id, limit: 1, offset: 1 }),
      ).toHaveLength(0);
      // vertical filter: a foreign-vertical RFQ under the same operator must
      // be invisible to scoped queries (shared-DB deployments — QA-294).
      await repo.createRfq({
        vertical: "machinery",
        listingId: listing.id,
        buyerEmail: `buyer-${tag}@test.dev`,
        fields: { name: "M Uyer", email: `buyer-${tag}@test.dev` },
      });
      expect(
        await repo.listRfqs({ operatorId: op.id, vertical: "jets" }),
      ).toHaveLength(1);
      expect(
        await repo.countRfqs({ operatorId: op.id, vertical: "jets" }),
      ).toBe(1);
      expect(
        await repo.listRfqs({ operatorId: op.id, vertical: "machinery" }),
      ).toHaveLength(1);
      expect(
        await repo.listRfqs({
          buyerEmail: `buyer-${tag}@test.dev`,
          vertical: "machinery",
        }),
      ).toHaveLength(1);
      expect(await repo.listRfqs({ operatorId: op.id })).toHaveLength(2);

      // Dedupe: same key collides (unique index / map) and resolves the
      // original RFQ; a different key or absent key inserts normally.
      const key = `dedupe-${tag}`;
      const first = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `dup-${tag}@test.dev`,
        fields: { ref: key },
        dedupeKey: key,
      });
      const dupErr = await repo
        .createRfq({
          vertical: "jets",
          listingId: listing.id,
          buyerEmail: `dup-${tag}@test.dev`,
          fields: { ref: key },
          dedupeKey: key,
        })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(dupErr).toBeTruthy();
      expect(isUniqueViolation(dupErr)).toBe(true);
      expect(await repo.getRfqByDedupeKey(key)).toMatchObject({
        id: first.id,
      });
      const other = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `dup-${tag}@test.dev`,
        fields: { ref: "other" },
        dedupeKey: `other-${tag}`,
      });
      expect(other.id).not.toBe(first.id);

      const quote = await repo.createQuote({
        rfqId: rfq.id,
        operatorId: op.id,
        amount: 20000,
        currency: "USD",
        message: "all-in",
      });
      expect(await repo.listQuotes({ rfqId: rfq.id })).toHaveLength(1);
      // QA-424 batch/filter additions, both impls: listRfqs ids-lookup
      // ignores non-uuid noise, listQuotes status isolates live offers.
      expect(
        (await repo.listRfqs({ ids: [rfq.id, other.id, "nope"] }))
          .map((r) => r.id)
          .sort(),
      ).toEqual([other.id, rfq.id].sort());
      expect(await repo.listRfqs({ ids: [] })).toEqual([]);
      expect(await repo.listRfqs({ ids: ["nope"] })).toEqual([]);
      expect(
        (await repo.listQuotes({ operatorId: op.id, status: "sent" })).map(
          (q) => q.id,
        ),
      ).toEqual([quote.id]);
      expect(
        await repo.listQuotes({ operatorId: op.id, status: "accepted" }),
      ).toEqual([]);
      // countQuotes mirrors the same filters without fetching rows (QA-151).
      expect(await repo.countQuotes({ operatorId: op.id })).toBe(1);
      expect(await repo.countQuotes({ operatorId: op.id, status: "sent" })).toBe(1);
      expect(await repo.countQuotes({ operatorId: first.id })).toBe(0);
      expect(await repo.countQuotes({ operatorId: op.id, status: "accepted" })).toBe(0);
      // `since` windows the counts by createdAt (rolling-30d stats, QA-208):
      // a future cutoff excludes, an old cutoff includes.
      const future = new Date(Date.now() + 86_400_000).toISOString();
      expect(
        await repo.countRfqs({ operatorId: op.id, since: future }),
      ).toBe(0);
      // 4 rows: the first RFQ + its foreign-vertical sibling + the two
      // dedupe RFQs — and scoping to "jets" drops the machinery one.
      expect(
        await repo.countRfqs({ operatorId: op.id, since: "2000-01-01" }),
      ).toBe(4);
      expect(
        await repo.countRfqs({
          operatorId: op.id,
          since: "2000-01-01",
          vertical: "jets",
        }),
      ).toBe(3);
      expect(
        await repo.countQuotes({ operatorId: op.id, since: future }),
      ).toBe(0);
      expect(
        await repo.countQuotes({
          operatorId: op.id,
          status: "sent",
          since: "2000-01-01",
        }),
      ).toBe(1);
      // Creating a quote moves the RFQ open → quoted.
      expect((await repo.getRfq(rfq.id))?.status).toBe("quoted");

      expect(await repo.setQuoteStatus(quote.id, "accepted", "sent")).toBe(
        true,
      );
      expect((await repo.getQuote(quote.id))?.status).toBe("accepted");
      // Conditional transition refuses to clobber a terminal state (QA-99):
      // a second "sent" guard fails and the row is untouched.
      expect(await repo.setQuoteStatus(quote.id, "declined", "sent")).toBe(
        false,
      );
      expect((await repo.getQuote(quote.id))?.status).toBe("accepted");

      // QA-386: a fractional fee rate must round-trip exactly — pg used to
      // store fee_pct numeric(5,2) and read 0.015 back as 0.02.
      const deal = await repo.createDeal({
        quoteId: quote.id,
        operatorId: op.id,
        amount: 20000,
        currency: "USD",
        feePct: 0.015,
        feeAmount: 300,
        invoiceStatus: "pending",
      });
      expect(deal.quoteId).toBe(quote.id);
      expect(deal.feePct).toBe(0.015);
      const deals = await repo.listDeals({ operatorId: op.id });
      expect(deals).toHaveLength(1);
      expect(deals[0]!.feePct).toBe(0.015);
    });

    it("dedupe replays only against a live twin; terminal RFQs re-mint", async () => {
      const repo = await factory();
      const tag = `rl-${Date.now().toString(36)}`;
      const user = await repo.createUser(`${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Dedupe Air",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      const listing = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `${tag} charter`,
        price: 9000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const key = `live-${tag}`;
      const mk = () =>
        ({
          vertical: "jets" as const,
          listingId: listing.id,
          buyerEmail: `dup-${tag}@test.dev`,
          fields: { ref: key },
          dedupeKey: key,
        });
      const first = await repo.createRfq(mk());
      // Live twin: insert collides, read resolves the original (QA-228).
      await expect(repo.createRfq(mk())).rejects.toThrow();
      expect((await repo.getRfqByDedupeKey(key))!.id).toBe(first.id);

      // Close it — a resubmit now mints a fresh RFQ instead of replaying.
      expect(
        await repo.setRfqStatus(first.id, "closed", [
          "open",
          "matched",
          "quoted",
        ]),
      ).toBe(true);
      const second = await repo.createRfq(mk());
      expect(second.id).not.toBe(first.id);
      expect((await repo.getRfqByDedupeKey(key))!.id).toBe(second.id);
    });

    it("createQuote never resurrects a closed RFQ (QA-165)", async () => {
      const repo = await factory();
      const tag = `res-${Date.now()}`;
      const user = await repo.createUser(`op-${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Res Air",
        baseAirport: "ZRH",
        fleetSummary: "1x",
        verified: false,
        plan: "free",
      });
      const listing = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `Res Jet ${tag}`,
        price: 100,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const rfq = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `res-${tag}@test.dev`,
        fields: { ref: "res" },
        dedupeKey: `res-${tag}`,
      });
      // Accept on a competing quote wins the race: RFQ is terminal.
      expect(await repo.setRfqStatus(rfq.id, "closed", ["open"])).toBe(true);
      // The loser's in-flight quote create lands anyway — it must NOT flip
      // the RFQ back to 'quoted' (second accept would mint a second deal).
      await repo.createQuote({
        rfqId: rfq.id,
        operatorId: op.id,
        amount: 100,
        currency: "USD",
        message: "",
      });
      expect((await repo.getRfq(rfq.id))?.status).toBe("closed");
    });

    it("setRfqStatus CAS admits exactly one winner under parallel contention", async () => {
      const repo = await factory();
      const tag = `cas-${Date.now()}`;
      const user = await repo.createUser(`op-${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Cas Air",
        baseAirport: "ZRH",
        fleetSummary: "1x",
        verified: false,
        plan: "free",
      });
      const listing = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `Cas Jet ${tag}`,
        price: 100,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const rfq = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `cas-${tag}@test.dev`,
        fields: {},
        dedupeKey: `cas-${tag}`,
      });
      // The accept route's single-winner gate relies on this CAS being
      // atomic: N concurrent accepts may only flip the RFQ once. Serial
      // tests can't prove it — drizzle serializes on the pg row lock, so
      // Promise.all must return exactly one true.
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          repo.setRfqStatus(rfq.id, "closed", ["open"]),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await repo.getRfq(rfq.id))?.status).toBe("closed");
    });

    it("fan-out matches grant inbox access; delayed matches hide until due", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const mk = async (n: string) => {
        const u = await repo.createUser(`${n}-${tag}@test.dev`, "operator");
        return repo.upsertOperator({
          userId: u.id,
          name: n,
          baseAirport: "ZRH",
          fleetSummary: "",
          verified: false,
          plan: "free",
        });
      };
      const [owner, matched, delayedOp] = await Promise.all([
        mk("owner"),
        mk("matched"),
        mk("delayed"),
      ]);
      const listing = await repo.createListing({
        operatorId: owner.id,
        vertical: "jets",
        type: "charter",
        title: `Fanout Jet ${tag}`,
        price: 7000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const rfq = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `b-${tag}@test.dev`,
        fields: { from: "ZRH", to: "NCE", dateTo: "2020-01-01" },
      });

      await repo.createRfqMatches([
        { rfqId: rfq.id, operatorId: matched.id, listingId: listing.id },
        {
          rfqId: rfq.id,
          operatorId: delayedOp.id,
          deliverAt: new Date(Date.now() + 60_000),
        },
      ]);

      // RFQ is marked matched off its initial state.
      expect((await repo.getRfq(rfq.id))?.status).toBe("matched");

      // Delivered match sees + can quote; delayed and unmatched do not.
      expect(await repo.hasRfqMatch(rfq.id, matched.id)).toBe(true);
      expect(await repo.hasRfqMatch(rfq.id, delayedOp.id)).toBe(false);
      expect(await repo.hasRfqMatch(rfq.id, owner.id)).toBe(false);
      expect((await repo.listRfqs({ operatorId: matched.id })).map((r) => r.id)).toContain(rfq.id);
      expect(await repo.countRfqs({ operatorId: matched.id })).toBe(1);
      expect((await repo.listRfqs({ operatorId: delayedOp.id })).map((r) => r.id)).not.toContain(rfq.id);

      // QA-225: the undelivered match is countable for the upsell teaser —
      // only for its operator, and not for terminal RFQs.
      expect(await repo.countPendingRfqs(delayedOp.id)).toBe(1);
      expect(await repo.countPendingRfqs(matched.id)).toBe(0);
      expect(await repo.countPendingRfqs(owner.id)).toBe(0);

      // QA-306: a delayed match on a FOREIGN-vertical RFQ must not inflate
      // this deploy's teaser (shared-DB isolation for the pending count).
      const foreignListing = await repo.createListing({
        operatorId: delayedOp.id,
        vertical: "machinery",
        type: "for_sale",
        title: `Foreign Pending ${tag}`,
        price: 5000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const foreignRfq = await repo.createRfq({
        vertical: "machinery",
        listingId: foreignListing.id,
        buyerEmail: `fb-${tag}@test.dev`,
        fields: {},
      });
      await repo.createRfqMatches([
        {
          rfqId: foreignRfq.id,
          operatorId: delayedOp.id,
          deliverAt: new Date(Date.now() + 60_000),
        },
      ]);
      expect(await repo.countPendingRfqs(delayedOp.id)).toBe(2);
      expect(await repo.countPendingRfqs(delayedOp.id, "jets")).toBe(1);
      expect(await repo.countPendingRfqs(delayedOp.id, "machinery")).toBe(1);

      await repo.expireRfqs(new Date(Date.now() + 86400000).toISOString());
      expect(await repo.countPendingRfqs(delayedOp.id)).toBe(1); // foreign rfq has no dateTo — survives expiry
    });

    it("inbox_seen_at: starts unset, stamps once, survives profile upserts (QA-416)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const u = await repo.createUser(`seen-${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: u.id,
        name: "Seen Op",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: false,
        plan: "free",
      });
      expect(op.inboxSeenAt).toBeUndefined();

      await repo.markInboxSeen(op.id);
      const stamped = (await repo.getOperator(op.id))!.inboxSeenAt;
      expect(stamped).toBeTruthy();
      // A second stamp only moves forward — never reverts.
      const before = stamped!;
      await repo.markInboxSeen(op.id);
      expect(
        (await repo.getOperator(op.id))!.inboxSeenAt! >= before,
      ).toBe(true);
      // Missing ids are a no-op, not a crash.
      await repo.markInboxSeen(crypto.randomUUID());

      // Profile upserts don't carry the stamp — it must survive untouched.
      const same = await repo.upsertOperator({
        userId: u.id,
        name: "Seen Op Renamed",
        baseAirport: "GVA",
        fleetSummary: "",
        verified: false,
        plan: "free",
      });
      expect(same.id).toBe(op.id);
      expect((await repo.getOperator(op.id))!.inboxSeenAt).toBeTruthy();
    });

    it("expediteRfq: concierge delivers delayed matches; terminal/repeat flips reject", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const mk = async (n: string) => {
        const u = await repo.createUser(`${n}-${tag}@test.dev`, "operator");
        return repo.upsertOperator({
          userId: u.id,
          name: n,
          baseAirport: "ZRH",
          fleetSummary: "",
          verified: false,
          plan: "free",
        });
      };
      const [owner, instantOp, delayedOp] = await Promise.all([
        mk("cowner"),
        mk("cinstant"),
        mk("cdelayed"),
      ]);
      const listing = await repo.createListing({
        operatorId: owner.id,
        vertical: "jets",
        type: "charter",
        title: `Concierge Jet ${tag}`,
        price: 7000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const rfq = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `cb-${tag}@test.dev`,
        fields: {},
      });
      const conciergeBefore = await repo.countRfqs({
        vertical: "jets",
        concierge: true,
      });
      await repo.createRfqMatches([
        { rfqId: rfq.id, operatorId: instantOp.id, listingId: listing.id },
        {
          rfqId: rfq.id,
          operatorId: delayedOp.id,
          deliverAt: new Date(Date.now() + 60_000),
        },
      ]);
      expect(await repo.hasRfqMatch(rfq.id, delayedOp.id)).toBe(false);
      // Only the still-delayed match is deliverable — the instant one never
      // counts toward what a concierge purchase would buy (QA-397).
      expect(await repo.countRfqPendingMatches(rfq.id)).toBe(1);

      const res = await repo.expediteRfq(rfq.id);
      expect(res.applied).toBe(true);
      // Only the still-delayed match flipped — the instant one was already
      // deliverable and must not be re-notified.
      expect(res.matches.map((m) => m.operatorId)).toEqual([delayedOp.id]);
      expect((await repo.getRfq(rfq.id))?.concierge).toBe(true);
      expect(await repo.hasRfqMatch(rfq.id, delayedOp.id)).toBe(true);
      // Teaser count drops to zero — expedited matches are no longer pending.
      expect(await repo.countPendingRfqs(delayedOp.id)).toBe(0);
      expect(await repo.countRfqPendingMatches(rfq.id)).toBe(0);
      // Concierge filter: the expedited RFQ joins the revenue count; a plain
      // one never does (admin dashboard stat, QA-394).
      expect(
        await repo.countRfqs({ vertical: "jets", concierge: true }),
      ).toBe(conciergeBefore + 1);
      await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `plain-${tag}@test.dev`,
        fields: {},
      });
      expect(
        await repo.countRfqs({ vertical: "jets", concierge: true }),
      ).toBe(conciergeBefore + 1);

      // Idempotent — a second purchase/webhook replay never re-flips.
      const again = await repo.expediteRfq(rfq.id);
      expect(again.applied).toBe(false);
      expect(again.matches).toEqual([]);

      // Terminal RFQs can't be expedited — a closed request must not take
      // money for dead matches.
      await repo.setRfqStatus(rfq.id, "closed", ["matched"]);
      const dead = await repo.expediteRfq(rfq.id);
      expect(dead.applied).toBe(false);
    });

    it("operator inbox sorts concierge RFQs first; other lists stay newest-first (QA-400)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const u = await repo.createUser(`sort-${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: u.id,
        name: "Sort Air",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      const listing = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `Sort Jet ${tag}`,
        price: 5000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const buyer = `sb-${tag}@test.dev`;
      const mk = () =>
        repo.createRfq({
          vertical: "jets",
          listingId: listing.id,
          buyerEmail: buyer,
          fields: {},
        });
      // Millisecond gaps keep the newest-first assertions deterministic.
      const r1 = await mk(); // oldest — becomes concierge
      await new Promise((r) => setTimeout(r, 10));
      const r2 = await mk();
      await new Promise((r) => setTimeout(r, 10));
      const r3 = await mk(); // newest

      await repo.expediteRfq(r1.id);

      // Operator surface: paid expedite leads even though it's the oldest.
      const inbox = await repo.listRfqs({ operatorId: op.id });
      expect(inbox.map((r) => r.id)).toEqual([r1.id, r3.id, r2.id]);

      // Buyer surface: same RFQs keep plain newest-first — the concierge
      // flag is an operator-priority signal, not the buyer's sort key.
      const mine = await repo.listRfqs({ buyerEmail: buyer });
      expect(mine.map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
    });

    it("needsQuote hides RFQs the operator already quoted (QA-402)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const mkOp = async (n: string) => {
        const u = await repo.createUser(`nq-${n}-${tag}@test.dev`, "operator");
        return repo.upsertOperator({
          userId: u.id,
          name: n,
          baseAirport: "ZRH",
          fleetSummary: "",
          verified: true,
          plan: "pro",
        });
      };
      const [owner, op, other] = await Promise.all([
        mkOp("nqowner"),
        mkOp("nqop"),
        mkOp("nqother"),
      ]);
      const listing = await repo.createListing({
        operatorId: owner.id,
        vertical: "jets",
        type: "charter",
        title: `NQ Jet ${tag}`,
        price: 5000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const mkRfq = (suffix: string) =>
        repo.createRfq({
          vertical: "jets",
          listingId: listing.id,
          buyerEmail: `nq-${suffix}-${tag}@test.dev`,
          fields: {},
        });
      const quotedRfq = await mkRfq("q");
      const freshRfq = await mkRfq("f");
      await repo.createRfqMatches([
        { rfqId: quotedRfq.id, operatorId: op.id, listingId: listing.id },
        { rfqId: freshRfq.id, operatorId: op.id, listingId: listing.id },
      ]);
      // op quoted the first RFQ; a DIFFERENT operator quoting the second
      // must not hide it from op's needs-quote view.
      await repo.createQuote({
        rfqId: quotedRfq.id,
        operatorId: op.id,
        amount: 9000,
        currency: "USD",
        message: "",
      });
      await repo.createQuote({
        rfqId: freshRfq.id,
        operatorId: other.id,
        amount: 8500,
        currency: "USD",
        message: "",
      });

      const all = await repo.listRfqs({ operatorId: op.id });
      expect(all.map((r) => r.id).sort()).toEqual(
        [quotedRfq.id, freshRfq.id].sort(),
      );
      const needs = await repo.listRfqs({ operatorId: op.id, needsQuote: true });
      expect(needs.map((r) => r.id)).toEqual([freshRfq.id]);
      // Pagination count matches the filtered page.
      expect(
        await repo.countRfqs({ operatorId: op.id, needsQuote: true }),
      ).toBe(1);

      // Declined/withdrawn quotes do NOT hide the RFQ — no live quote in play.
      const [q] = await repo.listQuotes({ rfqId: quotedRfq.id });
      await repo.setQuoteStatus(q!.id, "declined", "sent");
      const backIn = await repo.listRfqs({
        operatorId: op.id,
        needsQuote: true,
      });
      expect(backIn.map((r) => r.id).sort()).toEqual(
        [quotedRfq.id, freshRfq.id].sort(),
      );
    });

    it("answeredOnly shows only RFQs the operator has a live quote on (QA-433)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const mkOp = async (n: string) => {
        const u = await repo.createUser(`an-${n}-${tag}@test.dev`, "operator");
        return repo.upsertOperator({
          userId: u.id,
          name: n,
          baseAirport: "ZRH",
          fleetSummary: "",
          verified: true,
          plan: "pro",
        });
      };
      const [owner, op, other] = await Promise.all([
        mkOp("anowner"),
        mkOp("anop"),
        mkOp("another"),
      ]);
      const listing = await repo.createListing({
        operatorId: owner.id,
        vertical: "jets",
        type: "charter",
        title: `AN Jet ${tag}`,
        price: 5000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const mkRfq = (suffix: string) =>
        repo.createRfq({
          vertical: "jets",
          listingId: listing.id,
          buyerEmail: `an-${suffix}-${tag}@test.dev`,
          fields: {},
        });
      const quotedRfq = await mkRfq("q");
      const freshRfq = await mkRfq("f");
      await repo.createRfqMatches([
        { rfqId: quotedRfq.id, operatorId: op.id, listingId: listing.id },
        { rfqId: freshRfq.id, operatorId: op.id, listingId: listing.id },
      ]);
      // op answers the first; a DIFFERENT operator's quote on the second
      // must not count as answered for op.
      await repo.createQuote({
        rfqId: quotedRfq.id,
        operatorId: op.id,
        amount: 9000,
        currency: "USD",
        message: "",
      });
      await repo.createQuote({
        rfqId: freshRfq.id,
        operatorId: other.id,
        amount: 8500,
        currency: "USD",
        message: "",
      });

      const answered = await repo.listRfqs({
        operatorId: op.id,
        answeredOnly: true,
      });
      expect(answered.map((r) => r.id)).toEqual([quotedRfq.id]);
      // Pagination total mirrors the filtered page.
      expect(
        await repo.countRfqs({ operatorId: op.id, answeredOnly: true }),
      ).toBe(1);

      // Declining the quote drops the RFQ from "answered" — declined/
      // withdrawn are not live offers.
      const [q] = await repo.listQuotes({ rfqId: quotedRfq.id });
      await repo.setQuoteStatus(q!.id, "declined", "sent");
      expect(
        await repo.listRfqs({ operatorId: op.id, answeredOnly: true }),
      ).toEqual([]);
      expect(
        await repo.countRfqs({ operatorId: op.id, answeredOnly: true }),
      ).toBe(0);
    });

    it("countDeliveredMatches counts due rows only, batched (QA-401)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const u = await repo.createUser(`dm-${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: u.id,
        name: "DM Air",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      const listing = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `DM Jet ${tag}`,
        price: 5000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const u2 = await repo.createUser(`dm2-${tag}@test.dev`, "operator");
      const op2 = await repo.upsertOperator({
        userId: u2.id,
        name: "DM2 Air",
        baseAirport: "GVA",
        fleetSummary: "",
        verified: false,
        plan: "free",
      });
      const mkRfq = (suffix: string) =>
        repo.createRfq({
          vertical: "jets",
          listingId: listing.id,
          buyerEmail: `dm-${suffix}-${tag}@test.dev`,
          fields: {},
        });
      const deliveredRfq = await mkRfq("d");
      const mixedRfq = await mkRfq("m");
      const emptyRfq = await mkRfq("e");
      const future = new Date(Date.now() + 60_000);
      await repo.createRfqMatches([
        { rfqId: deliveredRfq.id, operatorId: op.id, listingId: listing.id },
        { rfqId: mixedRfq.id, operatorId: op.id, listingId: listing.id },
        {
          rfqId: mixedRfq.id,
          operatorId: op2.id,
          listingId: listing.id,
          deliverAt: future,
        },
      ]);

      const counts = await repo.countDeliveredMatches([
        deliveredRfq.id,
        mixedRfq.id,
        emptyRfq.id,
        // pg binds uuid[] — a real-but-unmatched id proves the miss path.
        crypto.randomUUID(),
      ]);
      expect(counts[deliveredRfq.id]).toBe(1);
      // The delayed match is NOT delivered yet — same visibility rule the
      // operator inbox applies.
      expect(counts[mixedRfq.id]).toBe(1);
      expect(counts[emptyRfq.id] ?? 0).toBe(0);
      expect(counts[crypto.randomUUID()] ?? 0).toBe(0);
      expect(await repo.countDeliveredMatches([])).toEqual({});

      // After expedite the delayed row joins the delivered count.
      await repo.expediteRfq(mixedRfq.id);
      expect(
        (await repo.countDeliveredMatches([mixedRfq.id]))[mixedRfq.id],
      ).toBe(2);
    });

    it("saved-search alert lifecycle: dedupe, confirm-once, unsubscribe (QA-403)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const input = (email: string, token: string, dedupeKey: string) => ({
        vertical: "jets",
        email,
        params: { type: "charter", f_aircraftCategory: "light" },
        token,
        dedupeKey,
      });
      const key = `sa-${tag}`;

      const first = await repo.createSearchAlert(
        input(`sa-${tag}@test.dev`, "tok1", key),
      );
      expect(first.created).toBe(true);
      expect(first.alert.status).toBe("pending");

      // Confirm flips once; a replayed link no-ops (idempotent CAS).
      const confirmed = await repo.confirmSearchAlert("tok1");
      expect(confirmed?.id).toBe(first.alert.id);
      expect(confirmed?.status).toBe("active");
      expect(await repo.confirmSearchAlert("tok1")).toBeNull();
      expect(await repo.confirmSearchAlert("nope")).toBeNull();

      // Re-subscribing the same dedupeKey rotates the token but keeps the
      // row + status — the older emailed confirm link is dead.
      const dup = await repo.createSearchAlert(
        input(`sa-${tag}@test.dev`, "tok2", key),
      );
      expect(dup.created).toBe(false);
      expect(dup.alert.id).toBe(first.alert.id);
      expect(dup.alert.status).toBe("active");
      expect(await repo.confirmSearchAlert("tok1")).toBeNull();

      // Vertical scoping + status filter.
      const jetsAlerts = await repo.listSearchAlerts({ vertical: "jets" });
      expect(jetsAlerts.some((a) => a.id === first.alert.id)).toBe(true);
      expect(
        (await repo.listSearchAlerts({ vertical: "machinery" })).some(
          (a) => a.id === first.alert.id,
        ),
      ).toBe(false);
      expect(
        (
          await repo.listSearchAlerts({ vertical: "jets", status: "pending" })
        ).some((a) => a.id === first.alert.id),
      ).toBe(false);

      // Buyer-inbox filter (QA-405): email scopes the same list; a second
      // mailbox's alert never leaks into the first mailbox's view.
      const other = await repo.createSearchAlert(
        input(`sa-other-${tag}@test.dev`, "tok-other", "k-other"),
      );
      const mine = await repo.listSearchAlerts({
        vertical: "jets",
        email: `sa-${tag}@test.dev`,
      });
      expect(mine.some((a) => a.id === first.alert.id)).toBe(true);
      expect(mine.some((a) => a.id === other.alert.id)).toBe(false);
      expect(mine[0]!.createdAt).toBeTruthy();

      // Cadence (QA-406): default 'instant', explicit 'daily' round-trips,
      // and a dedupe re-subscribe adopts the new freq (latest wins — the
      // key ignores freq so it can never fork two rows).
      expect(first.alert.freq).toBe("instant");
      const daily = await repo.createSearchAlert({
        ...input(`sa-d-${tag}@test.dev`, "tok-d", "k-d"),
        freq: "daily",
      });
      expect(daily.alert.freq).toBe("daily");
      const refreq = await repo.createSearchAlert({
        ...input(`sa-d-${tag}@test.dev`, "tok-d2", "k-d"),
        freq: "instant",
      });
      expect(refreq.created).toBe(false);
      expect(refreq.alert.freq).toBe("instant");

      // Cooldown backlog: distinct append, flush on mark. pg binds uuid[],
      // so pending ids must be real uuids even though this impl can't
      // validate they point at listings.
      const pend1 = crypto.randomUUID();
      const pend2 = crypto.randomUUID();
      await repo.appendSearchAlertPending(first.alert.id, pend1);
      await repo.appendSearchAlertPending(first.alert.id, pend2);
      await repo.appendSearchAlertPending(first.alert.id, pend1); // dup
      let row = (await repo.listSearchAlerts({ vertical: "jets" })).find(
        (a) => a.id === first.alert.id,
      )!;
      expect(row.pendingIds).toEqual([pend1, pend2]);
      await repo.markSearchAlerted(first.alert.id);
      row = (await repo.listSearchAlerts({ vertical: "jets" })).find(
        (a) => a.id === first.alert.id,
      )!;
      expect(row.pendingIds).toEqual([]);
      expect(row.lastAlertedAt).not.toBeNull();

      // Unsubscribe flips off; re-subscribe re-arms to pending (re-confirm).
      expect(await repo.unsubscribeSearchAlert("tok2")).toBe(true);
      expect(await repo.unsubscribeSearchAlert("tok2")).toBe(false);
      const resub = await repo.createSearchAlert(
        input(`sa-${tag}@test.dev`, "tok3", key),
      );
      expect(resub.alert.status).toBe("pending");
      // And now tok3 is the live confirm link.
      expect(
        (await repo.confirmSearchAlert("tok3"))?.status,
      ).toBe("active");
    });

    it("watch filters + countByWatch scope to active watchers only (QA-408)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const listingId = crypto.randomUUID();
      const otherId = crypto.randomUUID();
      const mk = (
        email: string,
        token: string,
        watch: string,
        dedupeKey: string,
      ) =>
        repo.createSearchAlert({
          vertical: "jets",
          email,
          params: { watch },
          token,
          dedupeKey,
        });

      // Two ACTIVE watchers on the same listing, one on another.
      await mk(`wa-${tag}@t.dev`, "wa", listingId, "wa");
      await mk(`wb-${tag}@t.dev`, "wb", listingId, "wb");
      await mk(`wc-${tag}@t.dev`, "wc", otherId, "wc");
      // A PENDING (never-confirmed) watch must not inflate the count.
      await mk(`wp-${tag}@t.dev`, "wp", listingId, "wp");
      // A non-watch alert is invisible to both filters.
      await repo.createSearchAlert({
        vertical: "jets",
        email: `nw-${tag}@t.dev`,
        params: { type: "charter" },
        token: "nw",
        dedupeKey: "nw",
      });
      await repo.confirmSearchAlert("wa");
      await repo.confirmSearchAlert("wb");
      await repo.confirmSearchAlert("wc");

      // watchListingId filter — exact id only.
      const watchers = await repo.listSearchAlerts({
        vertical: "jets",
        watchListingId: listingId,
      });
      expect(watchers.map((a) => a.email).sort()).toEqual([
        `wa-${tag}@t.dev`,
        `wb-${tag}@t.dev`,
        `wp-${tag}@t.dev`,
      ]);
      const activeWatchers = await repo.listSearchAlerts({
        vertical: "jets",
        status: "active",
        watchListingId: listingId,
      });
      expect(activeWatchers).toHaveLength(2);

      // Grouped demand counts — active only, watch-keyed rows only.
      const counts = await repo.countSearchAlertsByWatch("jets");
      expect(counts[listingId]).toBe(2);
      expect(counts[otherId]).toBe(1);
      expect(
        await repo.countSearchAlertsByWatch("machinery"),
      ).toEqual({});
    });

    it("countRfqsPerListing groups non-spam RFQs by owned listing (QA-417)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const mk = async (n: string) => {
        const u = await repo.createUser(`${n}-${tag}@test.dev`, "operator");
        return repo.upsertOperator({
          userId: u.id,
          name: n,
          baseAirport: "ZRH",
          fleetSummary: "",
          verified: false,
          plan: "free",
        });
      };
      const [owner, other] = await Promise.all([mk("rfqc-own"), mk("rfqc-oth")]);
      const a = await repo.createListing({
        operatorId: owner.id,
        vertical: "jets",
        type: "charter",
        title: `Count Jet A ${tag}`,
        price: 8000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const b = await repo.createListing({
        operatorId: owner.id,
        vertical: "jets",
        type: "charter",
        title: `Count Jet B ${tag}`,
        price: 8000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const foreign = await repo.createListing({
        operatorId: other.id,
        vertical: "jets",
        type: "charter",
        title: `Count Jet F ${tag}`,
        price: 8000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      // 2 on A, 1 spam on A (excluded), 0 on B, 1 on the foreign listing.
      for (const [i, lid] of [a.id, a.id, b.id, foreign.id].entries()) {
        await repo.createRfq({
          vertical: "jets",
          listingId: lid,
          buyerEmail: `c${i}-${tag}@test.dev`,
          fields: { dateTo: isoIn(5) },
        });
      }
      const counts = await repo.countRfqsPerListing(owner.id, "jets");
      expect(counts[a.id]).toBe(2);
      expect(counts[b.id]).toBe(1);
      expect(counts[foreign.id]).toBeUndefined();
      // Spam rows are moderation, not demand — drop them from the count.
      const spamRfq = await repo.createRfq({
        vertical: "jets",
        listingId: a.id,
        buyerEmail: `spam-${tag}@test.dev`,
        fields: { dateTo: isoIn(5) },
      });
      await repo.setRfqStatus(spamRfq.id, "spam", [
        "open",
        "matched",
        "quoted",
        "closed",
        "expired",
      ]);
      expect(
        (await repo.countRfqsPerListing(owner.id, "jets"))[a.id],
      ).toBe(2);
      // Cross-vertical + stranger scoping.
      expect(await repo.countRfqsPerListing(owner.id, "machinery")).toEqual({});
      expect(await repo.countRfqsPerListing(other.id, "jets")).toEqual({
        [foreign.id]: 1,
      });
    });

    it("deleteListing removes draft/archived only, FK set-nulls dependents (QA-419)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const u = await repo.createUser(`del-${tag}@test.dev`, "operator");
      const owner = await repo.upsertOperator({
        userId: u.id,
        name: "Del Owner",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: false,
        plan: "free",
      });
      const u2 = await repo.createUser(`del2-${tag}@test.dev`, "operator");
      const stranger = await repo.upsertOperator({
        userId: u2.id,
        name: "Del Stranger",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: false,
        plan: "free",
      });
      const mk = (title: string, status?: "draft" | "active" | "archived") =>
        repo.createListing({
          operatorId: owner.id,
          vertical: "jets",
          type: "charter",
          title: `${title} ${tag}`,
          price: 8000,
          currency: "USD",
          photos: [],
          attributes: {},
          ...(status ? { status } : {}),
        });
      const scope = { operatorId: owner.id, vertical: "jets" };

      // A draft with an RFQ against it: row goes, RFQ survives orphaned.
      const draft = await mk("Del Draft", "draft");
      const rfq = await repo.createRfq({
        vertical: "jets",
        listingId: draft.id,
        buyerEmail: `del-${tag}@test.dev`,
        fields: { dateTo: isoIn(5) },
      });
      expect(await repo.deleteListing(draft.id, scope)).toBe(true);
      expect(await repo.getListing(draft.id)).toBeUndefined();
      expect((await repo.getRfq(rfq.id))!.listingId).toBeNull();

      // Archived is also terminal enough to delete.
      const arch = await mk("Del Arch", "archived");
      expect(await repo.deleteListing(arch.id, scope)).toBe(true);

      // Live rows refuse — the delete is a no-op, not a status change.
      const live = await mk("Del Live", "active");
      expect(await repo.deleteListing(live.id, scope)).toBe(false);
      expect((await repo.getListing(live.id))!.status).toBe("active");
      const paused = await mk("Del Paused", "active");
      await repo.updateListingStatus(paused.id, "paused");
      expect(await repo.deleteListing(paused.id, scope)).toBe(false);

      // Scope is enforced inside the write: stranger or wrong-vertical
      // scopes can never reach the row.
      const mine = await mk("Del Mine", "draft");
      expect(
        await repo.deleteListing(mine.id, {
          operatorId: stranger.id,
          vertical: "jets",
        }),
      ).toBe(false);
      expect(
        await repo.deleteListing(mine.id, {
          operatorId: owner.id,
          vertical: "machinery",
        }),
      ).toBe(false);
      expect(await repo.getListing(mine.id)).toBeDefined();
    });

    it("dismissRfq hides only from that operator's inbox (QA-420)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const mk = async (n: string) => {
        const u = await repo.createUser(`${n}-${tag}@test.dev`, "operator");
        return repo.upsertOperator({
          userId: u.id,
          name: n,
          baseAirport: "ZRH",
          fleetSummary: "",
          verified: false,
          plan: "free",
        });
      };
      const owner = await mk("dsm-own");
      const matchedOp = await mk("dsm-mat");
      const stranger = await mk("dsm-str");
      const listing = await repo.createListing({
        operatorId: owner.id,
        vertical: "jets",
        type: "charter",
        title: `Dismiss Jet ${tag}`,
        price: 8000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const rfq = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `dsm-${tag}@test.dev`,
        fields: { dateTo: isoIn(5) },
      });
      await repo.createRfqMatches([
        { rfqId: rfq.id, operatorId: matchedOp.id, listingId: listing.id },
        {
          rfqId: rfq.id,
          operatorId: stranger.id,
          listingId: listing.id,
          deliverAt: new Date(Date.now() + 86_400_000),
        },
      ]);

      // Not-visible operators can't dismiss: stranger's match is still
      // delayed (undelivered), and an unknown id is a miss.
      expect(await repo.dismissRfq(rfq.id, stranger.id)).toBe(false);
      expect(await repo.dismissRfq("nope", owner.id)).toBe(false);

      const visible = () =>
        repo.listRfqs({ operatorId: owner.id, vertical: "jets" });
      expect((await visible()).some((r) => r.id === rfq.id)).toBe(true);
      expect(await repo.dismissRfq(rfq.id, owner.id)).toBe(true);
      expect((await visible()).some((r) => r.id === rfq.id)).toBe(false);
      // Replay stays idempotent-true.
      expect(await repo.dismissRfq(rfq.id, owner.id)).toBe(true);

      // Per-operator state: the delivered match still sees it, and the
      // buyer/admin-style unfiltered list is untouched.
      expect(
        (
          await repo.listRfqs({
            operatorId: matchedOp.id,
            vertical: "jets",
          })
        ).some((r) => r.id === rfq.id),
      ).toBe(true);
      expect(
        (await repo.listRfqs({ vertical: "jets" })).some(
          (r) => r.id === rfq.id,
        ),
      ).toBe(true);

      // Matched operator dismisses too — now invisible to both inboxes but
      // still listed unfiltered.
      expect(await repo.dismissRfq(rfq.id, matchedOp.id)).toBe(true);
      expect(
        (
          await repo.listRfqs({
            operatorId: matchedOp.id,
            vertical: "jets",
          })
        ).some((r) => r.id === rfq.id),
      ).toBe(false);

      // Delayed-match teaser + visibility gate: matchedOp's still-undelivered
      // match counts toward their pending teaser but can't be dismissed yet.
      const rfq2 = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `dsm2-${tag}@test.dev`,
        fields: { dateTo: isoIn(5) },
      });
      await repo.createRfqMatches([
        {
          rfqId: rfq2.id,
          operatorId: matchedOp.id,
          listingId: listing.id,
          deliverAt: new Date(Date.now() + 86_400_000),
        },
      ]);
      expect(await repo.countPendingRfqs(matchedOp.id, "jets")).toBe(1);
      expect(await repo.dismissRfq(rfq2.id, matchedOp.id)).toBe(false);
      expect(await repo.countPendingRfqs(matchedOp.id, "jets")).toBe(1);
      // rfq3: delivered match for stranger (past deliverAt), delayed for
      // matchedOp — pins that a delivered-match dismissal works and that an
      // undismissable delayed row keeps counting.
      const rfq3 = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `dsm3-${tag}@test.dev`,
        fields: { dateTo: isoIn(5) },
      });
      await repo.createRfqMatches([
        {
          rfqId: rfq3.id,
          operatorId: stranger.id,
          listingId: listing.id,
          deliverAt: new Date(Date.now() - 1000),
        },
        {
          rfqId: rfq3.id,
          operatorId: matchedOp.id,
          listingId: listing.id,
          deliverAt: new Date(Date.now() + 86_400_000),
        },
      ]);
      expect(await repo.countPendingRfqs(matchedOp.id, "jets")).toBe(2);
      expect(await repo.dismissRfq(rfq3.id, stranger.id)).toBe(true);
      expect(await repo.countPendingRfqs(matchedOp.id, "jets")).toBe(2);
      // Delivered-match dismissal drops it from that operator's inbox:
      expect(
        (
          await repo.listRfqs({ operatorId: stranger.id, vertical: "jets" })
        ).some((r) => r.id === rfq3.id),
      ).toBe(false);

      // QA-421: "Dismissed" view + undismiss. Dismissed-only flips the
      // exclusion: owner sees exactly rfq, stranger sees exactly rfq3 —
      // and the unflagged count/list keep excluding dismissed rows on
      // BOTH impls (drizzle countRfqs once lacked the dismissal clause —
      // totals must equal the list length, not count the hidden rows).
      const dismissedOf = (operatorId: string) =>
        repo.listRfqs({ operatorId, vertical: "jets", dismissedOnly: true });
      expect((await dismissedOf(owner.id)).map((r) => r.id)).toEqual([
        rfq.id,
      ]);
      expect((await dismissedOf(stranger.id)).map((r) => r.id)).toEqual([
        rfq3.id,
      ]);
      expect(
        await repo.countRfqs({
          operatorId: owner.id,
          vertical: "jets",
          dismissedOnly: true,
        }),
      ).toBe(1);
      expect(
        await repo.countRfqs({ operatorId: owner.id, vertical: "jets" }),
      ).toBe(
        (
          await repo.listRfqs({ operatorId: owner.id, vertical: "jets" })
        ).length,
      );

      // Undismiss restores visibility; replay and stranger restores miss.
      expect(await repo.undismissRfq(rfq.id, owner.id)).toBe(true);
      expect(await repo.undismissRfq(rfq.id, owner.id)).toBe(false);
      expect(await repo.undismissRfq("nope", owner.id)).toBe(false);
      expect(await repo.undismissRfq(rfq3.id, matchedOp.id)).toBe(false);
      expect((await visible()).some((r) => r.id === rfq.id)).toBe(true);
      expect((await dismissedOf(owner.id)).length).toBe(0);
    });

    it("bumpListingViews increments atomically and starts at 0 (QA-413)", async () => {
      const repo = await factory();
      const user = await repo.createUser(
        `views-${Date.now().toString(36)}@test.dev`,
        "operator",
      );
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Views Air",
        baseAirport: "GVA",
        fleetSummary: "",
        verified: false,
        plan: "free",
      });
      const listing = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: "Viewed Jet",
        price: 1000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      expect(listing.views).toBe(0);

      await repo.bumpListingViews(listing.id);
      await repo.bumpListingViews(listing.id);
      await repo.bumpListingViews(crypto.randomUUID()); // no row — no throw
      const after = await repo.getListing(listing.id);
      expect(after?.views).toBe(2);

      // A sibling listing's counter stays untouched.
      const other = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: "Unviewed Jet",
        price: 500,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      expect(other.views).toBe(0);
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

    it("enforces the listing cap atomically on create and reactivate", async () => {
      const repo = await factory();
      const user = await repo.createUser(
        `cap-${Date.now().toString(36)}@test.dev`,
        "operator",
      );
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "Cap Air",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: false,
        plan: "free",
      });
      const mk = (title: string) =>
        repo.createListing(
          {
            operatorId: op.id,
            vertical: "jets",
            type: "charter",
            title,
            price: 1000,
            currency: "USD",
            photos: [],
            attributes: {},
          },
          { cap: 3 },
        );
      const [a, b, c] = await Promise.all([mk("A"), mk("B"), mk("C")]);
      // Fourth create under cap 3 must be rejected by the repo itself.
      await expect(mk("D")).rejects.toMatchObject({ name: "PlanCapError" });
      // Uncapped path still writes.
      await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: "Pro",
        price: 1000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      expect(await repo.countOperatorListings(op.id)).toBe(4);
      void c;

      // A paused listing already counts toward the cap, so reactivating it
      // adds nothing: resolves while the other non-archived listings sit
      // below the cap (archive B first -> others for A = C + Pro = 2).
      await repo.updateListingStatus(a.id, "paused");
      await repo.updateListingStatus(b.id, "archived");
      await expect(
        repo.updateListingStatus(a.id, "active", { cap: 3 }),
      ).resolves.toBeUndefined();
      // An archived listing is NOT counted, so reactivating it while the
      // other non-archived listings fill the cap must be rejected.
      await expect(
        repo.updateListingStatus(b.id, "active", { cap: 3 }),
      ).rejects.toMatchObject({ name: "PlanCapError" });
    });

    it("listing cap holds under parallel creates (FOR UPDATE serialization)", async () => {
      const repo = await factory();
      const user = await repo.createUser(
        `caprace-${Date.now().toString(36)}@test.dev`,
        "operator",
      );
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "CapRace Air",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: false,
        plan: "free",
      });
      const mk = (title: string) =>
        repo.createListing(
          {
            operatorId: op.id,
            vertical: "jets",
            type: "charter",
            title,
            price: 1000,
            currency: "USD",
            photos: [],
            attributes: {},
          },
          { cap: 3 },
        );
      // 5 racers against cap 3: the operator-row FOR UPDATE lock serializes
      // count+insert, so exactly 3 land and 2 get PlanCapError — a check-then-
      // insert impl would let all 5 through.
      const results = await Promise.allSettled(
        ["R1", "R2", "R3", "R4", "R5"].map((t) => mk(t)),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      const capped = results.filter(
        (r) => r.status === "rejected" && r.reason?.name === "PlanCapError",
      );
      expect(ok).toHaveLength(3);
      expect(capped).toHaveLength(2);
      expect(await repo.countOperatorListings(op.id)).toBe(3);
    });

    it("parallel same-email createUser returns one user (QA-333)", async () => {
      const repo = await factory();
      const email = `dupe-${Date.now().toString(36)}@test.dev`;
      const users = await Promise.all(
        Array.from({ length: 4 }, () => repo.createUser(email, "buyer")),
      );
      const ids = new Set(users.map((u) => u.id));
      expect(ids.size).toBe(1);
      expect(users[0]?.email).toBe(email);
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

    it("bumpSessionVersion invalidates sessions server-side", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const user = await repo.createUser(`sv-${tag}@test.dev`);
      expect(user.sessionVersion).toBe(1);
      await repo.bumpSessionVersion(user.id);
      expect((await repo.getUser(user.id))?.sessionVersion).toBe(2);
      // Missing users are a no-op, not an error.
      await repo.bumpSessionVersion(
        "00000000-0000-0000-0000-000000000000",
      );

      // ADMIN_EMAILS sync path: promote to admin and back.
      await repo.setUserRole(user.id, "admin");
      expect((await repo.getUser(user.id))?.role).toBe("admin");
      await repo.setUserRole(user.id, "operator");
      expect((await repo.getUser(user.id))?.role).toBe("operator");
    });

    it("magic-link signatures are single-use, persisted in the repo (QA-250)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const exp = new Date(Date.now() + 60_000).toISOString();
      expect(await repo.consumeMagicLinkSig(`sig-${tag}-a`, exp)).toBe(true);
      // Replay loses — under postgres the ledger is a table, so a restart or
      // a second instance can't re-arm a consumed link (QA-250).
      expect(await repo.consumeMagicLinkSig(`sig-${tag}-a`, exp)).toBe(false);
      expect(await repo.consumeMagicLinkSig(`sig-${tag}-b`, exp)).toBe(true);
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

      // Orphaned-RFQ listing ids ("" from set-null on delete) must not
      // poison the ids lookup — Postgres would reject "" as uuid (QA-154).
      const byIds = await repo.listListings({ ids: ["", b.id] });
      expect(byIds.map((l) => l.id)).toEqual([b.id]);
      expect(await repo.listListings({ ids: [""] })).toEqual([]);
    });

    it("stores money in currency-aware minor units (0-digit currency)", async () => {
      const repo = await factory();
      const tag = `jpy${Date.now().toString(36)}`;
      const user = await repo.createUser(`${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: "JPY Air",
        baseAirport: "HND",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      const l = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "empty_leg",
        title: `${tag} HND to NGO`,
        price: 1500,
        currency: "JPY",
        photos: [],
        attributes: { from: "HND", to: "NGO" },
      });
      // JPY has 0 minor digits — ¥1,500 must not read back as ¥15 (QA-226).
      expect((await repo.getListing(l.id))!.price).toBe(1500);

      // Range-facet bounds are major units in the listing's own currency.
      const inRange = await repo.listListings({
        operatorId: op.id,
        facetRanges: [{ key: "price", min: 1000, max: 2000 }],
      });
      expect(inRange.map((x) => x.id)).toContain(l.id);
      const outOfRange = await repo.listListings({
        operatorId: op.id,
        facetRanges: [{ key: "price", min: 2001 }],
      });
      expect(outOfRange.map((x) => x.id)).not.toContain(l.id);

      // updateListing converts under the row's currency, not a fixed *100.
      await repo.updateListing(l.id, { price: 2000 });
      expect((await repo.getListing(l.id))!.price).toBe(2000);
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
      // sort (QA-178): distinct prices make the order fully deterministic;
      // newest-first default stays creation order.
      const byPriceAsc = await repo.listListings({ ...base, sort: "price_asc" });
      expect(byPriceAsc.map((l) => l.price)).toEqual([1000, 1001, 1002, 1003, 1004]);
      const byPriceDesc = await repo.listListings({ ...base, sort: "price_desc" });
      expect(byPriceDesc.map((l) => l.price)).toEqual([1004, 1003, 1002, 1001, 1000]);
      const sortedPage = await repo.listListings({
        ...base,
        sort: "price_desc",
        limit: 2,
      });
      expect(sortedPage.map((l) => l.price)).toEqual([1004, 1003]);
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
      // facetDateRanges (QA-215): ISO text bounds; missing attr never matches.
      const withDate = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "empty_leg",
        title: `${tag} dated-leg`,
        price: 4200,
        currency: "USD",
        photos: [],
        attributes: { date: "2026-10-15" },
      });
      const dated = await repo.listListings({
        ...base,
        facetDateRanges: [{ key: "date", from: "2026-10-01", to: "2026-10-31" }],
      });
      expect(dated.map((l) => l.id)).toEqual([withDate.id]);
      expect(
        await repo.countListings({
          ...base,
          facetDateRanges: [{ key: "date", to: "2026-10-31" }],
        }),
      ).toBe(1);
      expect(
        await repo.countListings({
          ...base,
          facetDateRanges: [{ key: "date", from: "2026-11-01" }],
        }),
      ).toBe(0);

      // notExpiredByAttr (QA-219): only the expiry type's past-dated rows
      // drop out — same-type attr-less rows and other types stay visible.
      const expiredLeg = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "empty_leg",
        title: `${tag} flew-yesterday`,
        price: 1,
        currency: "USD",
        photos: [],
        attributes: { date: "2020-01-01" },
      });
      const undatedLeg = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "empty_leg",
        title: `${tag} date-tbd`,
        price: 1,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const notExpiredByAttr = {
        type: "empty_leg",
        attr: "date",
        asOf: "2026-01-01",
      };
      const survivors = (
        await repo.listListings({ ...base, notExpiredByAttr })
      ).map((l) => l.id);
      expect(survivors).not.toContain(expiredLeg.id);
      expect(survivors).toContain(undatedLeg.id);
      expect(survivors).toContain(withDate.id); // 2026-10-15 ≥ asOf
      expect(
        await repo.countListings({ ...base, notExpiredByAttr }),
      ).toBeGreaterThanOrEqual(3);
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

    it("default sort puts pro operators' listings first (QA-191 priority placement)", async () => {
      const repo = await factory();
      const tag = `pro${Date.now().toString(36)}`;
      const freeUser = await repo.createUser(`${tag}-f@test.dev`, "operator");
      const freeOp = await repo.upsertOperator({
        userId: freeUser.id,
        name: "Free Air",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: true,
        plan: "free",
      });
      const proUser = await repo.createUser(`${tag}-p@test.dev`, "operator");
      const proOp = await repo.upsertOperator({
        userId: proUser.id,
        name: "Pro Air",
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      // The pro listing is OLDER — it still wins the default ordering.
      const proListing = await repo.createListing({
        operatorId: proOp.id,
        vertical: "jets",
        type: "charter",
        title: `${tag} pro`,
        price: 9000,
        currency: "USD",
        photos: [],
        attributes: { aircraftCategory: "light" },
      });
      await new Promise((r) => setTimeout(r, 10));
      const freeListing = await repo.createListing({
        operatorId: freeOp.id,
        vertical: "jets",
        type: "charter",
        title: `${tag} free`,
        price: 1000,
        currency: "USD",
        photos: [],
        attributes: { aircraftCategory: "light" },
      });
      const ids = [proListing.id, freeListing.id];

      const featured = await repo.listListings({ ids, sort: "newest" });
      expect(featured.map((l) => l.id)).toEqual([
        proListing.id,
        freeListing.id,
      ]);
      // Explicit price sort stays pure — pro boost doesn't leak into it.
      const byPrice = await repo.listListings({ ids, sort: "price_asc" });
      expect(byPrice.map((l) => l.id)).toEqual([
        freeListing.id,
        proListing.id,
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

      // Undated request (e.g. machinery for-sale): survives the sweep — the
      // 30-day stale horizon hasn't elapsed.
      const undated = await repo.createRfq({
        vertical: "machinery",
        listingId: listing.id,
        buyerEmail: `buyer-${tag}@test.dev`,
        fields: { budgetEur: 50000 },
      });

      const res = await repo.expireRfqs(new Date().toISOString());
      expect(res).toEqual({ rfqs: 1, quotes: 1 });
      expect((await repo.getRfq(undated.id))?.status).toBe("open");
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
        currency: "USD",
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
      // CAS (QA-145): expectedIn gates the transition — a paid invoice can't
      // be voided/re-invoiced by a racing writer.
      expect(await repo.setDealInvoice(deal.id, "void", undefined, ["invoiced"])).toBe(false);
      expect(await repo.setDealInvoice(deal.id, "invoiced", "inv_x", ["pending"])).toBe(false);
      expect((await repo.getDeal(deal.id))?.invoiceStatus).toBe("paid");
      expect((await repo.getDeal(deal.id))?.invoiceRef).toBe("inv_test_1");
      // deals.quote_id is unique — a racing double-accept must be rejected.
      await expect(
        repo.createDeal({
          quoteId: quote.id,
          operatorId: op.id,
          amount: 5000,
          currency: "USD",
          feePct: 0.03,
          feeAmount: 150,
          invoiceStatus: "pending",
        }),
      ).rejects.toThrow();

      // QA-171: the fee aggregate is ALL deals, not a page's worth — a
      // limited listDeals must not affect it.
      const rfq2 = await repo.createRfq({
        vertical: "jets",
        listingId: listing.id,
        buyerEmail: `b2-${tag}@test.dev`,
        fields: {},
      });
      const quote2 = await repo.createQuote({
        rfqId: rfq2.id,
        operatorId: op.id,
        amount: 10000,
        currency: "USD",
        message: "",
      });
      await repo.createDeal({
        quoteId: quote2.id,
        operatorId: op.id,
        amount: 10000,
        currency: "USD",
        feePct: 0.02,
        feeAmount: 200,
        invoiceStatus: "pending",
      });
      expect(await repo.sumDealFees()).toBeGreaterThanOrEqual(350);
      expect(
        await repo.sumDealFees({ operatorId: op.id }),
      ).toBe(350);
      expect(
        (await repo.listDeals({ operatorId: op.id, limit: 1 })).length,
      ).toBe(1);
    });

    it("countDealsPerOperator groups closed deals per op, vertical-scoped (QA-431)", async () => {
      const repo = await factory();
      const tag = `dt-${Date.now().toString(36)}`;
      const mk = async (email: string, rfqVertical = "jets") => {
        const user = await repo.createUser(email, "operator");
        const op = await repo.upsertOperator({
          userId: user.id,
          name: `Track ${tag} ${email}`,
          baseAirport: "ZRH",
          fleetSummary: "",
          verified: true,
          plan: "pro",
        });
        const listing = await repo.createListing({
          operatorId: op.id,
          vertical: rfqVertical,
          type: "charter",
          title: `Track listing ${email}`,
          price: 9000,
          currency: "USD",
          photos: [],
          attributes: {},
        });
        const rfq = await repo.createRfq({
          vertical: rfqVertical,
          listingId: listing.id,
          buyerEmail: `buyer-${email}`,
          fields: {},
        });
        return { op, listing, rfq };
      };
      // Two jets deals for op A, one machinery deal for op B — a buyer
      // comparing jets quotes must not see machinery volume.
      const a = await mk(`a-${tag}@test.dev`);
      const b = await mk(`b-${tag}@test.dev`, "machinery");
      const close = async (op: (typeof a)["op"], rfq: (typeof a)["rfq"]) => {
        const quote = await repo.createQuote({
          rfqId: rfq.id,
          operatorId: op.id,
          amount: 10_000,
          currency: "USD",
          message: "m",
        });
        await repo.createDeal({
          quoteId: quote.id,
          operatorId: op.id,
          amount: 10_000,
          currency: "USD",
          feePct: 0.015,
          feeAmount: 150,
          invoiceStatus: "paid",
        });
      };
      await close(a.op, a.rfq);
      const a2 = await repo.createRfq({
        vertical: "jets",
        listingId: a.listing.id,
        buyerEmail: `buyer2-${tag}@test.dev`,
        fields: {},
      });
      await close(a.op, a2);
      await close(b.op, b.rfq);

      const counts = await repo.countDealsPerOperator(
        [a.op.id, b.op.id, "not-a-uuid"],
        "jets",
      );
      expect(counts[a.op.id]).toBe(2);
      expect(counts[b.op.id]).toBeUndefined();
      expect(counts["not-a-uuid"]).toBeUndefined();
      // Machinery scope sees only op B's row.
      const mach = await repo.countDealsPerOperator(
        [a.op.id, b.op.id],
        "machinery",
      );
      expect(mach[a.op.id]).toBeUndefined();
      expect(mach[b.op.id]).toBe(1);
      // Empty input → empty record, no query.
      expect(await repo.countDealsPerOperator([], "jets")).toEqual({});
    });

    it("listRfqs/countRfqs scope to one listing (QA-430)", async () => {
      const repo = await factory();
      const tag = `lf-${Date.now().toString(36)}`;
      const user = await repo.createUser(`${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: `Filter Air ${tag}`,
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      const mkListing = (title: string) =>
        repo.createListing({
          operatorId: op.id,
          vertical: "jets",
          type: "charter",
          title,
          price: 9000,
          currency: "USD",
          photos: [],
          attributes: {},
        });
      const a = await mkListing(`Alpha ${tag}`);
      const b = await mkListing(`Beta ${tag}`);
      const rfqA = await repo.createRfq({
        vertical: "jets",
        listingId: a.id,
        buyerEmail: `ba-${tag}@test.dev`,
        fields: {},
      });
      await repo.createRfq({
        vertical: "jets",
        listingId: b.id,
        buyerEmail: `bb-${tag}@test.dev`,
        fields: {},
      });
      // Open request — no listing — never shows up under a listing filter.
      await repo.createRfq({
        vertical: "jets",
        listingId: null,
        buyerEmail: `bo-${tag}@test.dev`,
        fields: {},
      });

      const filtered = await repo.listRfqs({
        operatorId: op.id,
        listingId: a.id,
      });
      expect(filtered.map((r) => r.id)).toEqual([rfqA.id]);
      expect(
        await repo.countRfqs({ operatorId: op.id, listingId: a.id }),
      ).toBe(1);
      // Composes with needsQuote on both impls.
      expect(
        await repo.listRfqs({
          operatorId: op.id,
          listingId: a.id,
          needsQuote: true,
        }),
      ).toHaveLength(1);
      // Non-uuid listingIds miss — drizzle must not 22P02 (pg would throw
      // invalid-uuid on the bare eq; memory compares strings and misses).
      expect(
        await repo.listRfqs({ operatorId: op.id, listingId: "nope" }),
      ).toEqual([]);
      expect(
        await repo.countRfqs({ operatorId: op.id, listingId: "nope" }),
      ).toBe(0);
      // A uuid the operator doesn't own returns empty, not the foreign RFQ.
      const [other] = await repo.listRfqs({
        operatorId: op.id,
        listingId: b.id,
      });
      expect(other).toBeDefined();
      const foreignOp = await repo.upsertOperator({
        userId: (
          await repo.createUser(`stranger-${tag}@test.dev`, "operator")
        ).id,
        name: `Stranger ${tag}`,
        baseAirport: "GVA",
        fleetSummary: "",
        verified: false,
        plan: "free",
      });
      expect(
        await repo.listRfqs({
          operatorId: foreignOp.id,
          listingId: a.id,
        }),
      ).toEqual([]);
    });

    it("listDeals resolves rfq + buyer + listing context (QA-428)", async () => {
      const repo = await factory();
      const tag = `ctx-${Date.now().toString(36)}`;
      const user = await repo.createUser(`${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: `Context Air ${tag}`,
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: true,
        plan: "pro",
      });
      const listing = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `Ctx Jet ${tag}`,
        price: 9000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const mk = async (listingId: string | null, email: string) => {
        const rfq = await repo.createRfq({
          vertical: "jets",
          listingId,
          buyerEmail: email,
          fields: {},
        });
        const quote = await repo.createQuote({
          rfqId: rfq.id,
          operatorId: op.id,
          amount: 1000,
          currency: "USD",
          message: "",
        });
        return repo.createDeal({
          quoteId: quote.id,
          operatorId: op.id,
          amount: 1000,
          currency: "USD",
          feePct: 0.03,
          feeAmount: 30,
          invoiceStatus: "pending",
        });
      };
      const listed = await mk(listing.id, `listed-${tag}@test.dev`);
      // Listing-less "open request" RFQs still close — buyer contact is
      // populated, listingTitle stays undefined.
      const open = await mk(null, `open-${tag}@test.dev`);

      const rows = await repo.listDeals({ operatorId: op.id });
      const byId = new Map(rows.map((d) => [d.id, d] as const));
      expect(byId.get(listed.id)).toMatchObject({
        rfqId: expect.any(String),
        buyerEmail: `listed-${tag}@test.dev`,
        listingTitle: `Ctx Jet ${tag}`,
      });
      expect(byId.get(open.id)).toMatchObject({
        rfqId: expect.any(String),
        buyerEmail: `open-${tag}@test.dev`,
      });
      expect(byId.get(open.id)?.listingTitle).toBeUndefined();
    });

    it("covers the admin/listing aggregate helpers (QA-274)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const u1 = await repo.createUser(`agg1-${tag}@test.dev`, "operator");
      const u2 = await repo.createUser(`agg2-${tag}@test.dev`, "buyer");

      // listUsers batch-lookup; empty input must not degenerate to "all".
      const users = await repo.listUsers([u1.id, u2.id]);
      expect(users.map((u) => u.id).sort()).toEqual([u1.id, u2.id].sort());
      expect(await repo.listUsers([])).toEqual([]);
      expect(await repo.listUsers(["missing"])).toEqual([]);

      const op = await repo.upsertOperator({
        userId: u1.id,
        name: `Agg Air ${tag}`,
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: false,
        plan: "pro",
      });
      // listOperators / countOperators consistency + ids filter.
      const allOps = await repo.listOperators();
      expect(await repo.countOperators()).toBe(allOps.length);
      expect(allOps.some((o) => o.id === op.id)).toBe(true);
      expect(await repo.listOperators({ ids: [op.id] })).toHaveLength(1);
      expect(await repo.listOperators({ ids: [] })).toEqual([]);
      expect(await repo.listOperators({ limit: 1 })).toHaveLength(1);

      // Paged calls concatenate into the query's total order with no
      // repeats/skips — pg heap order alone would shuffle on UPDATE (QA-317).
      // allOps is already the ordered result; µs-precise created_at means a
      // JS-side re-sort can't reproduce pg's order for same-ms rows, so
      // compare pages against the ordered list itself.
      const paged = [];
      for (let off = 0; off < allOps.length; off += 1) {
        paged.push(...(await repo.listOperators({ limit: 1, offset: off })));
      }
      expect(paged.map((o) => o.id)).toEqual(allOps.map((o) => o.id));

      // listListingCountsByOperator: non-archived counts keyed by operator.
      const l1 = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `Agg one ${tag}`,
        price: 1000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `Agg two ${tag}`,
        price: 2000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const archived = await repo.createListing({
        operatorId: op.id,
        vertical: "jets",
        type: "charter",
        title: `Agg old ${tag}`,
        price: 500,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      await repo.updateListingStatus(archived.id, "archived");
      const counts = await repo.listListingCountsByOperator([op.id]);
      expect(counts[op.id]).toBe(2);
      // An unknown operator id yields no key (or zero) — never a phantom row.
      expect(counts["missing"] ?? 0).toBe(0);

      // countDeals agrees with listDeals (scoped + unscoped).
      const rfq = await repo.createRfq({
        vertical: "jets",
        listingId: l1.id,
        buyerEmail: `agg-b-${tag}@test.dev`,
        fields: {},
      });
      const q = await repo.createQuote({
        rfqId: rfq.id,
        operatorId: op.id,
        amount: 4000,
        currency: "USD",
        message: "",
      });
      await repo.createDeal({
        quoteId: q.id,
        operatorId: op.id,
        amount: 4000,
        currency: "USD",
        feePct: 0.03,
        feeAmount: 120,
        invoiceStatus: "pending",
      });
      const allDeals = await repo.listDeals({ limit: 1000 });
      expect(await repo.countDeals()).toBe(allDeals.length);
      const scopedDeals = await repo.listDeals({
        operatorId: op.id,
        limit: 1000,
      });
      expect(await repo.countDeals({ operatorId: op.id })).toBe(
        scopedDeals.length,
      );
      expect(scopedDeals.length).toBeGreaterThanOrEqual(1);

      // QA-313: admin deal list/count/fee-sum are per-vertical on a shared
      // DB — a foreign-vertical deal (resolved deal→quote→rfq) must not
      // enter this deploy's ledger.
      const foreignListing = await repo.createListing({
        operatorId: op.id,
        vertical: "machinery",
        type: "for_sale",
        title: `Foreign Deal ${tag}`,
        price: 5000,
        currency: "USD",
        photos: [],
        attributes: {},
      });
      const foreignRfq = await repo.createRfq({
        vertical: "machinery",
        listingId: foreignListing.id,
        buyerEmail: `agg-f-${tag}@test.dev`,
        fields: {},
      });
      const fq = await repo.createQuote({
        rfqId: foreignRfq.id,
        operatorId: op.id,
        amount: 5000,
        currency: "USD",
        message: "",
      });
      // Other contract tests also mint machinery deals on this shared pg —
      // assert deltas, not absolutes (QA-431's fixture predates this one).
      const machBefore = await repo.countDeals({ vertical: "machinery" });
      const machFeeBefore = await repo.sumDealFees({ vertical: "machinery" });
      await repo.createDeal({
        quoteId: fq.id,
        operatorId: op.id,
        amount: 5000,
        currency: "USD",
        feePct: 0.02,
        feeAmount: 100,
        invoiceStatus: "pending",
      });
      const jetsDeals = await repo.listDeals({
        vertical: "jets",
        limit: 1000,
      });
      expect(
        await repo.listDeals({ vertical: "machinery", limit: 1000 }),
      ).toHaveLength(machBefore + 1);
      expect(jetsDeals.length).toBe(allDeals.length - machBefore);
      expect(await repo.countDeals({ vertical: "jets" })).toBe(
        jetsDeals.length,
      );
      expect(await repo.countDeals()).toBe(allDeals.length + 1);
      // same-operator foreign deal: vertical still wins over operatorId.
      expect(
        await repo.countDeals({ operatorId: op.id, vertical: "jets" }),
      ).toBe(scopedDeals.length);
      expect(await repo.sumDealFees({ vertical: "machinery" })).toBe(
        machFeeBefore + 100,
      );

      // Jobs queue: memory mode has no queue (always empty/no-op by design);
      // the shared assertion is shape-only — an array and false on unknown id.
      expect(Array.isArray(await repo.listJobs())).toBe(true);
      expect(Array.isArray(await repo.listJobs({ status: "failed" }))).toBe(
        true,
      );
      expect(await repo.retryJob(`missing-${tag}`)).toBe(false);
    });

    it("listOperatorDirectory counts active+unexpired only, per vertical (QA-426)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const mkOp = async (n: string) =>
        repo.upsertOperator({
          userId: (await repo.createUser(`${n}-${tag}@test.dev`, "operator")).id,
          name: `Dir ${n} ${tag}`,
          baseAirport: "ZRH",
          fleetSummary: "",
          verified: false,
          plan: "pro",
        });
      const mkListing = (
        operatorId: string,
        patch: Partial<Parameters<Repo["createListing"]>[0]> = {},
      ) =>
        repo.createListing({
          operatorId,
          vertical: "jets",
          type: "empty_leg",
          title: `Dir leg ${tag}`,
          price: 1000,
          currency: "USD",
          photos: [],
          attributes: {},
          ...patch,
        });

      // Two qualifying operators; ordering = most-active first.
      const opA = await mkOp("a");
      await mkListing(opA.id, { title: `Dir a1 ${tag}` });
      await mkListing(opA.id, { title: `Dir a2 ${tag}` });
      const opB = await mkOp("b");
      await mkListing(opB.id, { title: `Dir b1 ${tag}` });

      // Disqualified: paused-only, archived-only, foreign-vertical only.
      const opPaused = await mkOp("p");
      const paused = await mkListing(opPaused.id, { title: `Dir p1 ${tag}` });
      await repo.updateListingStatus(paused.id, "paused");
      const opArch = await mkOp("x");
      const arch = await mkListing(opArch.id, { title: `Dir x1 ${tag}` });
      await repo.updateListingStatus(arch.id, "archived");
      const opForeign = await mkOp("f");
      await mkListing(opForeign.id, {
        vertical: "machinery",
        type: "excavator",
        title: `Dir f1 ${tag}`,
      });
      // Expired dated inventory qualifies ONLY when no expiry predicate is
      // passed (browse parity is opt-in, same as listListings).
      const opExp = await mkOp("e");
      await mkListing(opExp.id, {
        title: `Dir e1 ${tag}`,
        attributes: { date: "2000-01-01" },
      });

      const rows = await repo.listOperatorDirectory({ vertical: "jets" });
      const mine = rows.filter((r) => r.operator.name.endsWith(tag));
      expect(mine.map((r) => r.operator.id)).toEqual(
        expect.arrayContaining([opA.id, opB.id, opExp.id]),
      );
      // Most-active first is the one deterministic ordering pin.
      expect(mine[0]?.operator.id).toBe(opA.id);
      expect(mine[0]?.activeCount).toBe(2);
      expect(
        Object.fromEntries(mine.map((r) => [r.operator.id, r.activeCount])),
      ).toMatchObject({ [opB.id]: 1, [opExp.id]: 1 });
      expect(mine.map((r) => r.operator.id)).not.toContain(opPaused.id);
      expect(mine.map((r) => r.operator.id)).not.toContain(opArch.id);
      expect(mine.map((r) => r.operator.id)).not.toContain(opForeign.id);

      // With the browse expiry predicate the past-dated leg drops out —
      // undated legs of the same type stay (NULL-safe parity with browse).
      const browseRows = await repo.listOperatorDirectory({
        vertical: "jets",
        notExpiredByAttr: {
          type: "empty_leg",
          attr: "date",
          asOf: new Date().toISOString().slice(0, 10),
        },
      });
      const browseMine = browseRows.filter((r) =>
        r.operator.name.endsWith(tag),
      );
      expect(browseMine.map((r) => r.operator.id)).toEqual([opA.id, opB.id]);

      // limit clamps; machinery sees only its own operator.
      expect(
        await repo.listOperatorDirectory({ vertical: "jets", limit: 1 }),
      ).toHaveLength(1);
      const foreign = await repo.listOperatorDirectory({
        vertical: "machinery",
      });
      expect(
        foreign.filter((r) => r.operator.name.endsWith(tag)),
      ).toEqual([
        {
          operator: expect.objectContaining({ id: opForeign.id }),
          activeCount: 1,
        },
      ]);
    });

    it("setOperatorAccepting round-trips; upserts preserve the away flag (QA-427)", async () => {
      const repo = await factory();
      const tag = Date.now().toString(36);
      const user = await repo.createUser(`away-${tag}@test.dev`, "operator");
      const op = await repo.upsertOperator({
        userId: user.id,
        name: `Away Air ${tag}`,
        baseAirport: "ZRH",
        fleetSummary: "",
        verified: false,
        plan: "free",
      });
      // Default ON.
      expect(op.acceptingRfqs).toBe(true);
      await repo.setOperatorAccepting(op.id, false);
      expect((await repo.getOperator(op.id))?.acceptingRfqs).toBe(false);
      // A profile upsert that doesn't pass the flag keeps the operator's
      // current state (same stamp-survival rule as inboxSeenAt).
      await repo.upsertOperator({
        userId: user.id,
        name: `Away Air renamed ${tag}`,
        baseAirport: "GVA",
        fleetSummary: "",
        verified: false,
        plan: "pro",
      });
      expect((await repo.getOperator(op.id))?.acceptingRfqs).toBe(false);
      // ...but an upsert MAY pass it explicitly.
      await repo.upsertOperator({
        userId: user.id,
        name: `Away Air ${tag}`,
        baseAirport: "GVA",
        fleetSummary: "",
        verified: false,
        plan: "pro",
        acceptingRfqs: true,
      });
      expect((await repo.getOperator(op.id))?.acceptingRfqs).toBe(true);
      await repo.setOperatorAccepting(op.id, false);
      expect((await repo.getOperator(op.id))?.acceptingRfqs).toBe(false);
      await repo.setOperatorAccepting(op.id, true);
      expect((await repo.getOperator(op.id))?.acceptingRfqs).toBe(true);
      // Unknown id is a silent miss (non-uuid probe-safe on pg).
      await repo.setOperatorAccepting(`missing-${tag}`, false);
    });
  });
}
