/**
 * Shared Repo contract suite — run the same assertions against every Repo
 * implementation (memory, drizzle) so behavior can't drift between backends.
 */
import { describe, expect, it } from "vitest";
import type { Repo } from "../../lib/repo/types";
import { isUniqueViolation } from "../../lib/api";

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

      const deal = await repo.createDeal({
        quoteId: quote.id,
        operatorId: op.id,
        amount: 20000,
        currency: "USD",
        feePct: 0.03,
        feeAmount: 600,
        invoiceStatus: "pending",
      });
      expect(deal.quoteId).toBe(quote.id);
      expect(await repo.listDeals({ operatorId: op.id })).toHaveLength(1);
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
      ).toHaveLength(1);
      expect(jetsDeals.length).toBe(allDeals.length);
      expect(await repo.countDeals({ vertical: "jets" })).toBe(
        jetsDeals.length,
      );
      expect(await repo.countDeals()).toBe(jetsDeals.length + 1);
      // same-operator foreign deal: vertical still wins over operatorId.
      expect(
        await repo.countDeals({ operatorId: op.id, vertical: "jets" }),
      ).toBe(scopedDeals.length);
      expect(await repo.sumDealFees({ vertical: "machinery" })).toBe(100);

      // Jobs queue: memory mode has no queue (always empty/no-op by design);
      // the shared assertion is shape-only — an array and false on unknown id.
      expect(Array.isArray(await repo.listJobs())).toBe(true);
      expect(Array.isArray(await repo.listJobs({ status: "failed" }))).toBe(
        true,
      );
      expect(await repo.retryJob(`missing-${tag}`)).toBe(false);
    });
  });
}
