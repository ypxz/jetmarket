import { storageProvider } from "@jetmarket/providers";
import { PlanCapError } from "./types";
import type {
  Deal,
  JobInfo,
  Listing,
  ListingSort,
  Operator,
  Plan,
  Quote,
  Repo,
  Rfq,
  Subscription,
  User,
  UserRole,
} from "./types";

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();

/** Iface statuses that count as live for dedupe/fan-out reads. */
const LIVE_RFQ_STATUSES: ReadonlySet<Rfq["status"]> = new Set([
  "open",
  "matched",
  "quoted",
]);

class MemoryRepo implements Repo {
  users = new Map<string, User>();
  operators = new Map<string, Operator>();
  listings = new Map<string, Listing>();
  rfqs = new Map<string, Rfq>();
  quotes = new Map<string, Quote>();
  deals = new Map<string, Deal>();
  subscriptions = new Map<string, Subscription>();
  /** rfqId -> operatorId -> match row (memory-mode fan-out, QA-89). */
  rfqMatches = new Map<
    string,
    Map<string, { listingId: string | null; deliverAt?: Date }>
  >();

  async createUser(email: string, role: UserRole = "buyer"): Promise<User> {
    const normalized = email.toLowerCase();
    // Find synchronously — awaiting findUserByEmail would yield the
    // microtask queue and let a parallel same-email create duplicate the
    // user (QA-333). Drizzle is atomic via ON CONFLICT + re-read.
    const existing = [...this.users.values()].find(
      (u) => u.email === normalized,
    );
    if (existing) return existing;
    const u: User = {
      id: uid("usr"),
      email: normalized,
      role,
      sessionVersion: 1,
      createdAt: now(),
    };
    this.users.set(u.id, u);
    return u;
  }
  async findUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email);
  }
  async getUser(id: string) {
    return this.users.get(id);
  }
  async listUsers(ids: string[]) {
    const want = new Set(ids);
    return [...this.users.values()].filter((u) => want.has(u.id));
  }
  async bumpSessionVersion(userId: string) {
    const u = this.users.get(userId);
    if (u) u.sessionVersion += 1;
  }
  async setUserRole(userId: string, role: UserRole) {
    const u = this.users.get(userId);
    if (u) u.role = role;
  }

  /** sig -> expiry ms; same bound + fail-closed as the old in-proc map. */
  private usedMagicSigs = new Map<string, number>();

  async consumeMagicLinkSig(sig: string, expiresAt: string) {
    if (this.usedMagicSigs.has(sig)) return false;
    if (this.usedMagicSigs.size >= 10_000) {
      const now = Date.now();
      for (const [k, exp] of this.usedMagicSigs) {
        if (exp < now) this.usedMagicSigs.delete(k);
      }
      if (this.usedMagicSigs.size >= 10_000) return false;
    }
    this.usedMagicSigs.set(sig, Date.parse(expiresAt));
    return true;
  }

  async upsertOperator(
    o: Omit<Operator, "id" | "createdAt"> & { id?: string },
  ): Promise<Operator> {
    // Parity with the drizzle ON CONFLICT (user_id) path: no explicit id
    // means upsert on the one-profile-per-user invariant.
    const byUser = [...this.operators.values()].find(
      (x) => x.userId === o.userId,
    );
    const id = o.id ?? byUser?.id ?? uid("op");
    const prev = this.operators.get(id);
    const op: Operator = { ...o, id, createdAt: prev?.createdAt ?? now() };
    this.operators.set(id, op);
    return op;
  }
  async getOperator(id: string) {
    return this.operators.get(id);
  }
  async getOperatorByUserId(userId: string) {
    return [...this.operators.values()].find((o) => o.userId === userId);
  }
  async listOperators(filter?: {
    limit?: number;
    offset?: number;
    ids?: string[];
  }): Promise<Operator[]> {
    let out = [...this.operators.values()];
    if (filter?.ids) {
      const want = new Set(filter.ids);
      out = out.filter((o) => want.has(o.id));
    }
    // Same deterministic order as the drizzle repo (createdAt desc, id
    // tiebreak) — admin pagination depends on it (QA-317).
    out.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? -1 : 1),
    );
    if (filter?.offset) out = out.slice(filter.offset);
    if (filter?.limit !== undefined) out = out.slice(0, filter.limit);
    return out;
  }
  async countOperators(): Promise<number> {
    return this.operators.size;
  }
  async setOperatorVerified(id: string, verified: boolean) {
    const op = this.operators.get(id);
    if (op) this.operators.set(id, { ...op, verified });
  }
  async setOperatorPlan(id: string, plan: Plan) {
    const op = this.operators.get(id);
    if (op) this.operators.set(id, { ...op, plan });
  }

  async createListing(
    l: Omit<Listing, "id" | "createdAt" | "status"> & {
      status?: Listing["status"];
    },
    opts?: { cap?: number },
  ): Promise<Listing> {
    if (opts?.cap !== undefined) {
      // Count synchronously: awaiting countOperatorListings would yield the
      // microtask queue and let parallel callers all observe count < cap
      // (QA-332) — drizzle gets the same atomicity from FOR UPDATE.
      let n = 0;
      for (const x of this.listings.values()) {
        if (
          x.operatorId === l.operatorId &&
          x.status !== "archived" &&
          x.vertical === l.vertical
        ) {
          n += 1;
        }
      }
      if (n >= opts.cap) throw new PlanCapError();
    }
    const listing: Listing = {
      ...l,
      id: uid("lst"),
      status: l.status ?? "active",
      createdAt: now(),
    };
    this.listings.set(listing.id, listing);
    return listing;
  }
  async getListing(id: string) {
    return this.listings.get(id);
  }
  async listListings(filter?: {
    operatorId?: string;
    status?: Listing["status"];
    type?: Listing["type"];
    vertical?: string;
    query?: string;
    facets?: Record<string, string>;
    facetRanges?: { key: string; min?: number; max?: number }[];
    facetDateRanges?: { key: string; from?: string; to?: string }[];
    notExpiredByAttr?: { type: string; attr: string; asOf: string };
    ids?: string[];
    sort?: ListingSort;
    limit?: number;
    offset?: number;
  }): Promise<Listing[]> {
    // createdAt desc trails every sort for stable paging (QA-178).
    const byNewest = (a: Listing, b: Listing) =>
      b.createdAt.localeCompare(a.createdAt);
    // Default ("newest") ordering honors the Pro plan's priority-placement
    // feature: pro operators' listings sort first, then newest (QA-191).
    const proRank = (l: Listing) =>
      this.operators.get(l.operatorId)?.plan === "pro" ? 0 : 1;
    const byFeatured = (a: Listing, b: Listing) =>
      proRank(a) - proRank(b) || byNewest(a, b);
    const cmp =
      filter?.sort === "price_asc"
        ? (a: Listing, b: Listing) => a.price - b.price || byNewest(a, b)
        : filter?.sort === "price_desc"
          ? (a: Listing, b: Listing) => b.price - a.price || byNewest(a, b)
          : byFeatured;
    const out = this.filterListings(filter).sort(cmp);
    const start = filter?.offset ?? 0;
    return filter?.limit !== undefined
      ? out.slice(start, start + filter.limit)
      : out.slice(start);
  }
  async countListings(filter?: {
    operatorId?: string;
    status?: Listing["status"];
    type?: Listing["type"];
    vertical?: string;
    query?: string;
    facets?: Record<string, string>;
    facetRanges?: { key: string; min?: number; max?: number }[];
    facetDateRanges?: { key: string; from?: string; to?: string }[];
    notExpiredByAttr?: { type: string; attr: string; asOf: string };
    ids?: string[];
  }): Promise<number> {
    return this.filterListings(filter).length;
  }
  private filterListings(filter?: {
    operatorId?: string;
    status?: Listing["status"];
    type?: Listing["type"];
    vertical?: string;
    query?: string;
    facets?: Record<string, string>;
    facetRanges?: { key: string; min?: number; max?: number }[];
    facetDateRanges?: { key: string; from?: string; to?: string }[];
    notExpiredByAttr?: { type: string; attr: string; asOf: string };
    ids?: string[];
  }): Listing[] {
    let out = [...this.listings.values()];
    if (filter?.ids) {
      const want = new Set(filter.ids);
      out = out.filter((l) => want.has(l.id));
    }
    if (filter?.operatorId) out = out.filter((l) => l.operatorId === filter.operatorId);
    if (filter?.status) out = out.filter((l) => l.status === filter.status);
    if (filter?.type) out = out.filter((l) => l.type === filter.type);
    if (filter?.vertical) out = out.filter((l) => l.vertical === filter.vertical);
    if (filter?.query) {
      const q = filter.query.toLowerCase();
      out = out.filter((l) =>
        [l.title, JSON.stringify(l.attributes)]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }
    if (filter?.facets) {
      for (const [k, v] of Object.entries(filter.facets)) {
        if (!v) continue;
        out = out.filter((l) => String(l.attributes[k] ?? "") === v);
      }
    }
    if (filter?.facetRanges) {
      for (const r of filter.facetRanges) {
        out = out.filter((l) => {
          const v = r.key === "price" ? l.price : l.attributes[r.key];
          const n = typeof v === "number" ? v : Number(v);
          if (!Number.isFinite(n)) return false;
          if (r.min !== undefined && n < r.min) return false;
          if (r.max !== undefined && n > r.max) return false;
          return true;
        });
      }
    }
    if (filter?.facetDateRanges) {
      for (const r of filter.facetDateRanges) {
        out = out.filter((l) => {
          const v = l.attributes[r.key];
          // ISO dates sort lexicographically; missing attr never matches.
          if (typeof v !== "string") return false;
          if (r.from !== undefined && v < r.from) return false;
          if (r.to !== undefined && v > r.to) return false;
          return true;
        });
      }
    }
    if (filter?.notExpiredByAttr) {
      const { type, attr, asOf } = filter.notExpiredByAttr;
      out = out.filter((l) => {
        if (l.type !== type) return true;
        const v = l.attributes[attr];
        return typeof v !== "string" || v >= asOf;
      });
    }
    return out;
  }
  async updateListingStatus(
    id: string,
    status: Listing["status"],
    opts?: { cap?: number },
  ) {
    const l = this.listings.get(id);
    if (l && status === "active" && opts?.cap !== undefined) {
      // Same-vertical only, matching drizzle — free-tier caps are per-
      // marketplace on a shared DB (QA-302).
      const others = [...this.listings.values()].filter(
        (x) =>
          x.operatorId === l.operatorId &&
          x.id !== id &&
          x.status !== "archived" &&
          x.vertical === l.vertical,
      ).length;
      if (others >= opts.cap) throw new PlanCapError();
    }
    if (l) this.listings.set(id, { ...l, status });
  }
  async updateListing(
    id: string,
    patch: Partial<Pick<Listing, "title" | "price" | "attributes" | "photos">>,
  ) {
    const l = this.listings.get(id);
    if (l) this.listings.set(id, { ...l, ...patch });
  }
  async countOperatorListings(operatorId: string, vertical?: string) {
    return [...this.listings.values()].filter(
      (l) =>
        l.operatorId === operatorId &&
        l.status !== "archived" &&
        (vertical === undefined || l.vertical === vertical),
    ).length;
  }
  async listListingCountsByOperator(operatorIds: string[], vertical?: string) {
    const want = new Set(operatorIds);
    const out: Record<string, number> = {};
    for (const l of this.listings.values()) {
      if (
        want.has(l.operatorId) &&
        l.status !== "archived" &&
        (vertical === undefined || l.vertical === vertical)
      ) {
        out[l.operatorId] = (out[l.operatorId] ?? 0) + 1;
      }
    }
    return out;
  }

  private rfqDedupe = new Map<string, string>(); // dedupeKey -> rfqId

  async createRfq(
    r: Omit<
      Rfq,
      "id" | "createdAt" | "status" | "accessToken" | "concierge"
    > & {
      dedupeKey?: string;
      accessToken?: string;
    },
  ): Promise<Rfq> {
    if (r.dedupeKey) {
      // Dedupe mirrors the db's partial unique index: it collides only with a
      // LIVE twin — a resubmit over a closed/spam RFQ mints a fresh one
      // (QA-228).
      const hitId = this.rfqDedupe.get(r.dedupeKey);
      const hit = hitId ? this.rfqs.get(hitId) : undefined;
      if (hit && LIVE_RFQ_STATUSES.has(hit.status)) {
        throw new Error("duplicate key value violates unique constraint");
      }
    }
    const { dedupeKey, accessToken, ...rest } = r;
    void dedupeKey;
    const rfq: Rfq = {
      ...rest,
      id: uid("rfq"),
      status: "open",
      concierge: false,
      accessToken: accessToken ?? crypto.randomUUID(),
      createdAt: now(),
    };
    this.rfqs.set(rfq.id, rfq);
    if (r.dedupeKey) this.rfqDedupe.set(r.dedupeKey, rfq.id);
    return rfq;
  }
  async getRfqByDedupeKey(key: string) {
    const id = this.rfqDedupe.get(key);
    const rfq = id ? this.rfqs.get(id) : undefined;
    return rfq && LIVE_RFQ_STATUSES.has(rfq.status) ? rfq : undefined;
  }
  async getRfq(id: string) {
    return this.rfqs.get(id);
  }
  async setRfqStatus(id: string, status: Rfq["status"], expectedIn: Rfq["status"][]) {
    const rfq = this.rfqs.get(id);
    if (!rfq || !expectedIn.includes(rfq.status)) return false;
    this.rfqs.set(id, { ...rfq, status });
    return true;
  }
  async expediteRfq(id: string) {
    const rfq = this.rfqs.get(id);
    if (!rfq || rfq.concierge || !LIVE_RFQ_STATUSES.has(rfq.status)) {
      return { applied: false, matches: [] };
    }
    // Check-to-write is synchronous — a parallel call can't interleave the
    // flag set with the match flip (same QA-333 rule as every mutator).
    rfq.concierge = true;
    const matches: { id: string; operatorId: string }[] = [];
    for (const [operatorId, m] of this.rfqMatches.get(id) ?? []) {
      // Still-delayed = deliverAt strictly in the future; already-due rows
      // are visible anyway and need no flip.
      if (m.deliverAt && m.deliverAt.getTime() > Date.now()) {
        m.deliverAt = new Date();
        // Memory matches have no row id — operatorId is the key callers
        // need (pg returns real match ids for job payloads instead).
        matches.push({ id: operatorId, operatorId });
      }
    }
    return { applied: true, matches };
  }
  async listRfqs(filter?: {
    buyerEmail?: string;
    operatorId?: string;
    vertical?: string;
    limit?: number;
    offset?: number;
  }): Promise<Rfq[]> {
    let out = [...this.rfqs.values()];
    if (filter?.vertical)
      out = out.filter((r) => r.vertical === filter.vertical);
    // buyerEmail is stored lowercase at create (QA-153); normalize the
    // lookup side so case re-entry still finds the inbox.
    if (filter?.buyerEmail)
      out = out.filter(
        (r) => r.buyerEmail === filter.buyerEmail!.toLowerCase(),
      );
    if (filter?.operatorId) {
      const opListingIds = new Set(
        [...this.listings.values()]
          .filter((l) => l.operatorId === filter.operatorId)
          .map((l) => l.id),
      );
      const opId = filter.operatorId;
      out = out.filter(
        (r) => opListingIds.has(r.listingId) || this.matchVisible(r.id, opId),
      );
    }
    out = out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (filter?.offset) out = out.slice(filter.offset);
    if (filter?.limit !== undefined) out = out.slice(0, filter.limit);
    return out;
  }

  /** A match is visible once due — no sweep needed in memory mode. */
  private matchVisible(rfqId: string, operatorId: string): boolean {
    const m = this.rfqMatches.get(rfqId)?.get(operatorId);
    return !!m && (!m.deliverAt || m.deliverAt.getTime() <= Date.now());
  }

  async hasRfqMatch(rfqId: string, operatorId: string): Promise<boolean> {
    return this.matchVisible(rfqId, operatorId);
  }

  async createRfqMatches(
    rows: {
      rfqId: string;
      operatorId: string;
      listingId?: string | null;
      deliverAt?: Date;
    }[],
  ): Promise<void> {
    for (const r of rows) {
      const forRfq = this.rfqMatches.get(r.rfqId) ?? new Map();
      forRfq.set(r.operatorId, {
        listingId: r.listingId ?? null,
        ...(r.deliverAt ? { deliverAt: r.deliverAt } : {}),
      });
      this.rfqMatches.set(r.rfqId, forRfq);
    }
    // Mirror markRfqMatched: only off the initial state, never resurrect.
    if (rows.length) {
      const rfq = this.rfqs.get(rows[0]!.rfqId);
      if (rfq && rfq.status === "open") rfq.status = "matched";
    }
  }

  async countRfqs(filter?: {
    buyerEmail?: string;
    operatorId?: string;
    vertical?: string;
    statusNot?: Rfq["status"][];
    since?: string;
    concierge?: boolean;
  }): Promise<number> {
    let out = await this.listRfqs({
      ...filter,
      limit: undefined,
      offset: undefined,
    });
    if (filter?.statusNot?.length) {
      const banned = new Set(filter.statusNot);
      out = out.filter((r) => !banned.has(r.status));
    }
    // ISO strings compare lexicographically — same convention as expiry cutoffs.
    if (filter?.since) out = out.filter((r) => r.createdAt >= filter.since!);
    if (filter?.concierge) out = out.filter((r) => r.concierge === true);
    return out.length;
  }

  /** Delayed = match exists but deliverAt is still in the future. */
  async countPendingRfqs(operatorId: string, vertical?: string): Promise<number> {
    const nowMs = Date.now();
    let n = 0;
    for (const [rfqId, forRfq] of this.rfqMatches) {
      const m = forRfq.get(operatorId);
      if (!m?.deliverAt || m.deliverAt.getTime() <= nowMs) continue;
      const rfq = this.rfqs.get(rfqId);
      const status = rfq?.status;
      if (status === "closed" || status === "expired" || status === "spam") {
        continue;
      }
      if (vertical && rfq?.vertical !== vertical) continue;
      n++;
    }
    return n;
  }

  async createQuote(q: Omit<Quote, "id" | "createdAt" | "status">): Promise<Quote> {
    const quote: Quote = { ...q, id: uid("quo"), status: "sent", createdAt: now() };
    this.quotes.set(quote.id, quote);
    // Same live-state guard as drizzle (QA-165): a closed/spam RFQ must not
    // resurrect to 'quoted' when a quote create races its terminal flip.
    const rfq = this.rfqs.get(quote.rfqId);
    if (
      rfq &&
      (rfq.status === "open" ||
        rfq.status === "matched" ||
        rfq.status === "quoted")
    ) {
      this.rfqs.set(rfq.id, { ...rfq, status: "quoted" });
    }
    return quote;
  }
  async getQuote(id: string) {
    return this.quotes.get(id);
  }
  async listQuotes(filter?: { rfqId?: string; operatorId?: string; ids?: string[]; rfqIds?: string[] }): Promise<Quote[]> {
    let out = [...this.quotes.values()];
    if (filter?.rfqId) out = out.filter((q) => q.rfqId === filter.rfqId);
    if (filter?.operatorId) out = out.filter((q) => q.operatorId === filter.operatorId);
    if (filter?.ids) {
      const want = new Set(filter.ids);
      out = out.filter((q) => want.has(q.id));
    }
    if (filter?.rfqIds) {
      const want = new Set(filter.rfqIds);
      out = out.filter((q) => want.has(q.rfqId));
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async countQuotes(filter?: { operatorId?: string; status?: Quote["status"]; since?: string }) {
    let out = [...this.quotes.values()];
    if (filter?.operatorId) out = out.filter((q) => q.operatorId === filter.operatorId);
    if (filter?.status) out = out.filter((q) => q.status === filter.status);
    if (filter?.since) out = out.filter((q) => q.createdAt >= filter.since!);
    return out.length;
  }
  async setQuoteStatus(id: string, status: Quote["status"], expected: Quote["status"]) {
    const q = this.quotes.get(id);
    if (!q || q.status !== expected) return false;
    this.quotes.set(id, { ...q, status });
    return true;
  }

  async expireRfqs(cutoff: string, vertical?: string) {
    const day = cutoff.slice(0, 10);
    const stale = new Date(cutoff);
    stale.setUTCDate(stale.getUTCDate() - 30);
    const expired = [...this.rfqs.values()].filter(
      (r) =>
        (vertical === undefined || r.vertical === vertical) &&
        (r.status === "open" ||
          r.status === "matched" ||
          r.status === "quoted") &&
        (typeof r.fields["dateTo"] === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(r.fields["dateTo"])
          ? r.fields["dateTo"] < day
          : r.createdAt < stale.toISOString()),
    );
    let quotes = 0;
    for (const r of expired) {
      this.rfqs.set(r.id, { ...r, status: "expired" });
      for (const q of this.quotes.values()) {
        if (q.rfqId === r.id && q.status === "sent") {
          this.quotes.set(q.id, { ...q, status: "declined" });
          quotes++;
        }
      }
    }
    return { rfqs: expired.length, quotes };
  }

  async listJobs(_filter?: {
    status?: "pending" | "running" | "done" | "failed";
    vertical?: string;
    limit?: number;
  }) {
    void _filter;
    return [] as JobInfo[];
  }
  async retryJob(id: string, _vertical?: string) {
    void id;
    void _vertical;
    return false;
  }

  async createDeal(d: Omit<Deal, "id" | "closedAt">): Promise<Deal> {
    // Mirrors deals.quote_id unique — concurrent accepts must not double-deal.
    if ([...this.deals.values()].some((x) => x.quoteId === d.quoteId)) {
      throw new Error("deal already exists for quote");
    }
    const deal: Deal = { ...d, id: uid("deal"), closedAt: now() };
    this.deals.set(deal.id, deal);
    return deal;
  }
  async getDeal(id: string) {
    return this.deals.get(id);
  }
  async setDealInvoice(
    id: string,
    status: Deal["invoiceStatus"],
    ref?: string,
    expectedIn?: Deal["invoiceStatus"][],
  ) {
    const deal = this.deals.get(id);
    if (!deal) return false;
    if (expectedIn && !expectedIn.includes(deal.invoiceStatus)) return false;
    this.deals.set(id, {
      ...deal,
      invoiceStatus: status,
      invoiceRef: ref ?? deal.invoiceRef,
    });
    return true;
  }
  async listDeals(filter?: {
    operatorId?: string;
    vertical?: string;
    limit?: number;
    offset?: number;
  }): Promise<Deal[]> {
    let out = [...this.deals.values()];
    if (filter?.operatorId) out = out.filter((d) => d.operatorId === filter.operatorId);
    // Deals carry no vertical — resolve through quote → rfq (QA-313).
    if (filter?.vertical) {
      const v = filter.vertical;
      out = out.filter((d) => {
        const q = this.quotes.get(d.quoteId);
        const r = q ? this.rfqs.get(q.rfqId) : undefined;
        return r?.vertical === v;
      });
    }
    out = out.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
    if (filter?.offset) out = out.slice(filter.offset);
    if (filter?.limit !== undefined) out = out.slice(0, filter.limit);
    return out;
  }
  async countDeals(filter?: {
    operatorId?: string;
    vertical?: string;
  }): Promise<number> {
    return (await this.listDeals({ ...filter, limit: undefined, offset: undefined }))
      .length;
  }
  async sumDealFees(filter?: {
    operatorId?: string;
    vertical?: string;
  }): Promise<number> {
    return (await this.listDeals({ ...filter, limit: undefined, offset: undefined }))
      .reduce((s, d) => s + d.feeAmount, 0);
  }

  async upsertSubscription(s: Omit<Subscription, "id">): Promise<Subscription> {
    // Read synchronously — an await before the stale-webhook gate would let
    // a raced stale event pass on a pre-write snapshot and clobber the
    // newer sub (QA-333). Drizzle gates inside the UPDATE.
    const prev = this.subscriptions.get(s.operatorId);
    // stale-webhook gate: stamped events only apply when newer
    if (
      s.lastEventAt != null &&
      prev?.lastEventAt != null &&
      s.lastEventAt <= prev.lastEventAt
    ) {
      return prev;
    }
    const sub: Subscription = { ...s, id: prev?.id ?? uid("sub") };
    this.subscriptions.set(s.operatorId, sub);
    return sub;
  }
  async getSubscription(operatorId: string) {
    return this.subscriptions.get(operatorId);
  }
}

export async function seedMemoryRepo(repo: MemoryRepo) {
  const vertical = process.env.VERTICAL ?? "jets";
  // One deployment = one vertical: the pg CLI seeds exclusively; memory mode
  // must mirror that or machinery demos show jets rows in vertical-
  // unfiltered surfaces (admin moderation lists across the board, QA-230).
  if (vertical === "machinery") await seedMachinery(repo);
  else await seedJets(repo);
}

// Tiny deterministic placeholder photo, stored via the storage provider so
// seeded listings exercise the same render path as uploaded ones.
async function seedPhoto(key: string, label: string, hue: number): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><rect width="800" height="450" fill="hsl(${hue},45%,18%)"/><text x="400" y="240" font-family="system-ui" font-size="28" fill="hsl(${hue},30%,85%)" text-anchor="middle">${label}</text></svg>`; // design-ok — SVG image content, not app styling
  await storageProvider().put(key, svg, { contentType: "image/svg+xml" });
  return key;
}

async function seedJets(repo: MemoryRepo) {
  const ops = [
    { email: "ops@alpine-air.example", name: "Alpine Air Charter", base: "ZRH", fleet: "Phenom 300, CJ4", verified: true, plan: "pro" as Plan },
    { email: "ops@lake-jet.example", name: "Lake Jet Geneva", base: "GVA", fleet: "Challenger 350", verified: true, plan: "free" as Plan },
    { email: "ops@riviera-wings.example", name: "Riviera Wings", base: "NCE", fleet: "G650, Falcon 2000", verified: false, plan: "free" as Plan },
    { email: "ops@thames-exec.example", name: "Thames Executive", base: "LTN", fleet: "Praetor 600", verified: true, plan: "pro" as Plan },
  ];
  const opIds: string[] = [];
  const opUserIds: string[] = [];
  for (const o of ops) {
    const u = await repo.createUser(o.email, "operator");
    const op = await repo.upsertOperator({
      userId: u.id,
      name: o.name,
      baseAirport: o.base,
      fleetSummary: o.fleet,
      verified: o.verified,
      plan: o.plan,
    });
    opIds.push(op.id);
    opUserIds.push(u.id);
  }
  // Leg dates are relative to seed time so the demo always shows upcoming
  // legs — hardcoded ISO dates would drift into the past (QA-215).
  const inDays = (n: number) =>
    new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const mk = async (
    operatorId: string,
    type: Listing["type"],
    title: string,
    price: number,
    attributes: Record<string, unknown>,
    photos: string[] = [],
  ) =>
    await repo.createListing({
      operatorId,
      vertical: "jets",
      type,
      title,
      attributes,
      price,
      currency: "USD",
      photos,
    });

  await mk(opIds[0]!, "empty_leg", "Empty leg Zurich → Nice · Phenom 300", 4200, {
    aircraftCategory: "light", model: "Phenom 300", year: 2021, seats: 7,
    rangeNm: 2000, from: "ZRH", to: "NCE", date: inDays(3),
  }, [
    await seedPhoto(`uploads/${opUserIds[0]}/seed-zrh-nce-phenom.svg`, "Phenom 300", 190),
  ]);
  await mk(opIds[0]!, "empty_leg", "Empty leg Geneva → London · CJ4", 6800, {
    aircraftCategory: "light", model: "Citation CJ4", year: 2019, seats: 8,
    rangeNm: 2165, from: "GVA", to: "LTN", date: inDays(6),
  });
  await mk(opIds[1]!, "charter", "Challenger 350 on-demand charter · Geneva", 8500, {
    aircraftCategory: "super_mid", model: "Challenger 350", year: 2020,
    seats: 9, rangeNm: 3200, baseAirport: "GVA",
  });
  await mk(opIds[1]!, "empty_leg", "Empty leg Nice → Zurich · Challenger 350", 7400, {
    aircraftCategory: "super_mid", model: "Challenger 350", year: 2020,
    seats: 9, rangeNm: 3200, from: "NCE", to: "ZRH", date: inDays(2),
  });
  // Yesterday's leg — exercised by the expiry filter (QA-219): invisible on
  // public surfaces, still on the operator dashboard.
  await mk(opIds[1]!, "empty_leg", "Empty leg Zurich → Ibiza · Challenger 350", 9800, {
    aircraftCategory: "super_mid", model: "Challenger 350", year: 2021,
    seats: 9, rangeNm: 3200, from: "ZRH", to: "IBZ", date: inDays(-1),
  });
  await mk(opIds[2]!, "aircraft_sale", "Gulfstream G650 (2018) for sale", 38500000, {
    aircraftCategory: "ultra_long", model: "G650", year: 2018, seats: 14,
    rangeNm: 7000, hoursTotal: 1450,
  }, [
    await seedPhoto(`uploads/${opUserIds[2]}/seed-g650.svg`, "Gulfstream G650", 35),
    await seedPhoto(`uploads/${opUserIds[2]}/seed-g650-cabin.svg`, "G650 cabin", 200),
  ]);
  await mk(opIds[2]!, "charter", "Falcon 2000LXS charter · Nice base", 7200, {
    aircraftCategory: "heavy", model: "Falcon 2000LXS", year: 2017, seats: 10,
    rangeNm: 4000, baseAirport: "NCE",
  });
  await mk(opIds[3]!, "empty_leg", "Empty leg London → Geneva · Praetor 600", 5900, {
    aircraftCategory: "mid", model: "Praetor 600", year: 2022, seats: 8,
    rangeNm: 4018, from: "LTN", to: "GVA", date: inDays(1),
  });
  await mk(opIds[3]!, "charter", "Praetor 600 charter · London Luton", 6300, {
    aircraftCategory: "mid", model: "Praetor 600", year: 2022, seats: 8,
    rangeNm: 4018, baseAirport: "LTN",
  });

  // Demo trail mirroring the pg seed (QA-237): an RFQ on alpine's ZRH→NCE
  // leg — delivered to thames (pro) with a live quote, delayed for the two
  // free ops — so mock-mode demos show the whole inbox loop, not empty
  // inboxes. Buyer link: /quotes?email=charter@geneva-pe.example
  // #t=demo-buyer-token (known token, dev-only data; `?t=` also still works).
  const demoListing = (await repo.listListings({ operatorId: opIds[0]! })).find(
    (l) => l.attributes?.["from"] === "ZRH" && l.attributes?.["to"] === "NCE",
  )!;
  const rfq = await repo.createRfq({
    vertical: "jets",
    listingId: demoListing.id,
    buyerEmail: "charter@geneva-pe.example",
    fields: {
      departure: "ZRH",
      arrival: "NCE",
      dateFrom: inDays(3),
      dateTo: inDays(4),
      passengers: 4,
      name: "Demo Buyer",
      email: "charter@geneva-pe.example",
    },
    dedupeKey: "seed-rfq-zrh-nce",
    accessToken: "demo-buyer-token",
  });
  const in23h = new Date(Date.now() + 23 * 3_600_000);
  await repo.createRfqMatches([
    { rfqId: rfq.id, operatorId: opIds[3]!, listingId: demoListing.id },
    {
      rfqId: rfq.id,
      operatorId: opIds[1]!,
      listingId: demoListing.id,
      deliverAt: in23h,
    },
    {
      rfqId: rfq.id,
      operatorId: opIds[2]!,
      listingId: demoListing.id,
      deliverAt: in23h,
    },
  ]);
  await repo.createQuote({
    rfqId: rfq.id,
    operatorId: opIds[3]!,
    amount: 14_500,
    currency: "USD",
    message: "Phenom 300, ZRH → NCE, all-in incl. handling and catering.",
  });
}

// Placeholder machinery inventory — proves the same repo/flow works for the
// second vertical (spec: machinery content is scaffold-only tonight).
async function seedMachinery(repo: MemoryRepo) {
  // A handful of dealers across categories so QA-229 category fan-out and
  // the browse grid actually demo something — was 1 dealer / 3 listings.
  const dealers = [
    { email: "ops@alpine-machinery.example", name: "Alpine Industrial Machines", base: "ZRH", fleet: "Decommissioned CNC + presses", verified: true, plan: "pro" as Plan },
    { email: "vertrieb@rhein-maschinen.example", name: "Rhein Maschinen", base: "DUS", fleet: "Presses + forming", verified: true, plan: "pro" as Plan },
    { email: "sales@ibérica-maquinaria.example", name: "Ibérica Maquinaria", base: "BIO", fleet: "Lathes", verified: true, plan: "free" as Plan },
    { email: "verkauf@nord-foerdertechnik.example", name: "Nord Fördertechnik", base: "HAM", fleet: "Conveyors", verified: true, plan: "free" as Plan },
    { email: "hire@lowlandsfl.example", name: "Lowlands Forklifts", base: "RTM", fleet: "Electric forklifts", verified: false, plan: "free" as Plan },
  ];
  const dealerIds: string[] = [];
  for (const d of dealers) {
    const u = await repo.createUser(d.email, "operator");
    const op = await repo.upsertOperator({
      userId: u.id,
      name: d.name,
      baseAirport: d.base,
      fleetSummary: d.fleet,
      verified: d.verified,
      plan: d.plan,
    });
    dealerIds.push(op.id);
  }
  const mk = async (operatorId: string, type: string, title: string, price: number, attributes: Record<string, unknown>, photos: string[] = []) =>
    await repo.createListing({
      operatorId,
      vertical: "machinery",
      type,
      title,
      attributes,
      price,
      currency: "EUR",
      photos,
    });

  const alpine = dealerIds[0]!;
  await mk(alpine, "for_sale", "DMG Mori CNC milling centre (2016)", 145000, {
    machineryCategory: "cnc_milling", make: "DMG Mori", yearOfManufacture: 2016,
    hoursUsed: 8200, condition: "used",
  }, [await seedPhoto(`uploads/${alpine}/seed-dmg-mori.svg`, "DMG Mori CNC", 160)]);
  await mk(alpine, "for_sale", "Hermle C 42 5-axis mill (2019)", 210000, {
    machineryCategory: "cnc_milling", make: "Hermle", yearOfManufacture: 2019,
    hoursUsed: 5400, condition: "used",
  });
  await mk(alpine, "for_sale", "Mazak QTN 250 lathe (2017)", 88000, {
    machineryCategory: "lathe", make: "Mazak", yearOfManufacture: 2017,
    hoursUsed: 9100, condition: "used",
  });
  await mk(dealerIds[1]!, "for_sale", "Trumpf TruBend press brake (2015)", 96500, {
    machineryCategory: "press", make: "Trumpf", yearOfManufacture: 2015,
    hoursUsed: 12400, condition: "used",
  });
  await mk(dealerIds[1]!, "auction", "Schuler hydraulic press 400t — liquidation lot", 28000, {
    machineryCategory: "press", make: "Schuler", yearOfManufacture: 2008,
    hoursUsed: 31000, condition: "decommissioned",
  });
  const okuma = await mk(dealerIds[2]!, "for_sale", "Okuma LB3000 lathe (2018)", 72000, {
    machineryCategory: "lathe", make: "Okuma", yearOfManufacture: 2018,
    hoursUsed: 6800, condition: "used",
  }, [await seedPhoto(`uploads/${dealerIds[2]}/seed-okuma.svg`, "Okuma LB3000", 30)]);
  await mk(dealerIds[3]!, "for_rent", "Dematic belt conveyor line 20m", 2400, {
    machineryCategory: "conveyor", make: "Dematic", yearOfManufacture: 2021,
    hoursUsed: 1200, condition: "used",
  });
  await mk(dealerIds[4]!, "for_rent", "Linde E39 electric forklift · monthly", 950, {
    machineryCategory: "forklift", make: "Linde", yearOfManufacture: 2019,
    hoursUsed: 4200, condition: "used",
  });

  // Demo trail mirroring the pg seed (QA-237): an RFQ on ibérica's Okuma
  // lathe — delivered to alpine (pro) with a live quote, delayed for nord +
  // lowlands (free) — so mock-mode demos show the whole inbox loop. Buyer
  // link: /quotes?email=procurement@bavaria-werk.example#t=demo-buyer-token-machinery
  // (per-vertical suffix — the pg column has a unique index, QA-314).
  const rfq = await repo.createRfq({
    vertical: "machinery",
    listingId: okuma.id,
    buyerEmail: "procurement@bavaria-werk.example",
    fields: {
      deliveryPostcode: "80331",
      budgetEur: 400_000,
      name: "Demo Buyer",
      email: "procurement@bavaria-werk.example",
    },
    dedupeKey: "seed-rfq-okuma-lathe",
    accessToken: "demo-buyer-token-machinery",
  });
  const in23h = new Date(Date.now() + 23 * 3_600_000);
  await repo.createRfqMatches([
    { rfqId: rfq.id, operatorId: dealerIds[0]!, listingId: okuma.id },
    {
      rfqId: rfq.id,
      operatorId: dealerIds[3]!,
      listingId: okuma.id,
      deliverAt: in23h,
    },
    {
      rfqId: rfq.id,
      operatorId: dealerIds[4]!,
      listingId: okuma.id,
      deliverAt: in23h,
    },
  ]);
  await repo.createQuote({
    rfqId: rfq.id,
    operatorId: dealerIds[0]!,
    amount: 385_000,
    currency: "EUR",
    message: "Okuma LB3000, incl. transport to 80331 and commissioning.",
  });
}

export async function createMemoryRepo(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await seedMemoryRepo(repo);
  return repo;
}

// module singleton survives Next dev HMR via globalThis
const g = globalThis as unknown as { __jmRepo?: MemoryRepo };
export async function getMemoryRepo(): Promise<MemoryRepo> {
  if (!g.__jmRepo) g.__jmRepo = await createMemoryRepo();
  return g.__jmRepo;
}
