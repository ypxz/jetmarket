import { storageProvider } from "@jetmarket/providers";
import { rfqDeadlineAt } from "../rfq-deadline";
import { PlanCapError } from "./types";
import type {
  AdminEvent,
  BlockedEmail,
  BuyerDeleteResult,
  BuyerExport,
  CounterRound,
  CounterRoundOutcome,
  Deal,
  JobInfo,
  Listing,
  ListingReport,
  ListingReportStatus,
  ListingSort,
  Operator,
  Plan,
  Quote,
  QuoteDeclineReason,
  QuoteReport,
  QuoteRevision,
  QuoteTemplate,
  Repo,
  Rfq,
  RfqAmendment,
  RfqNote,
  RfqReport,
  RfqReportStatus,
  SearchAlert,
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
  // QA-522: counter-round audit rows keyed by quote — appended on counter,
  // resolved on the round's exit.
  counterRounds = new Map<string, CounterRound[]>();
  // QA-530: superseded quote terms per quoteId, newest-first via unshift.
  private quoteRevisions = new Map<string, QuoteRevision[]>();
  private rfqAmendments = new Map<string, RfqAmendment[]>();
  deals = new Map<string, Deal>();
  subscriptions = new Map<string, Subscription>();
  /** rfqId -> operatorId -> match row (memory-mode fan-out, QA-89). */
  rfqMatches = new Map<
    string,
    Map<string, { listingId: string | null; deliverAt?: Date }>
  >();
  /** QA-524: operatorId -> rfqId -> private triage note. */
  rfqNotes = new Map<string, Map<string, RfqNote>>();
  /** QA-527: operatorId -> templateId -> saved quote preset. */
  quoteTemplates = new Map<string, Map<string, QuoteTemplate>>();

  async createUser(
    email: string,
    role: UserRole = "buyer",
    locale?: string,
  ): Promise<User> {
    const normalized = email.toLowerCase();
    // Find synchronously — awaiting findUserByEmail would yield the
    // microtask queue and let a parallel same-email create duplicate the
    // user (QA-333). Drizzle is atomic via ON CONFLICT + re-read.
    const existing = [...this.users.values()].find(
      (u) => u.email === normalized,
    );
    // Adopt-latest locale stays inside the sync window — an await between
    // check and write would re-open the QA-333 interleave.
    if (existing) {
      if (locale && existing.locale !== locale) existing.locale = locale;
      return existing;
    }
    const u: User = {
      id: uid("usr"),
      email: normalized,
      role,
      sessionVersion: 1,
      locale: locale ?? "en",
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
    o: Omit<
      Operator,
      "id" | "createdAt" | "acceptingRfqs" | "notifyRfqMatch" | "suspended"
    > & {
      id?: string;
      acceptingRfqs?: boolean;
      notifyRfqMatch?: boolean;
      suspended?: boolean;
    },
  ): Promise<Operator> {
    // Parity with the drizzle ON CONFLICT (user_id) path: no explicit id
    // means upsert on the one-profile-per-user invariant.
    const byUser = [...this.operators.values()].find(
      (x) => x.userId === o.userId,
    );
    const id = o.id ?? byUser?.id ?? uid("op");
    const prev = this.operators.get(id);
    const op: Operator = {
      ...o,
      id,
      // QA-427: default ON; an upsert that doesn't pass the switch keeps the
      // operator's current state (same stamp-survival rule as inboxSeenAt).
      acceptingRfqs: o.acceptingRfqs ?? prev?.acceptingRfqs ?? true,
      // QA-505: default ON; an upsert that doesn't pass the switch keeps
      // the operator's current state (same preserve rule as acceptingRfqs).
      notifyRfqMatch: o.notifyRfqMatch ?? prev?.notifyRfqMatch ?? true,
      // QA-460: default clear; an upsert that doesn't pass the flag keeps
      // the operator's current state (same preserve rule as the switch).
      suspended: o.suspended ?? prev?.suspended ?? false,
      createdAt: prev?.createdAt ?? now(),
      // QA-416: the inbox stamp survives profile upserts (callers never pass
      // it — upsert is a full-row shape).
      ...(prev?.inboxSeenAt !== undefined
        ? { inboxSeenAt: prev.inboxSeenAt }
        : {}),
    };
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
  async setOperatorAccepting(id: string, accepting: boolean) {
    const op = this.operators.get(id);
    if (op) this.operators.set(id, { ...op, acceptingRfqs: accepting });
  }
  async setOperatorNotifyRfqMatch(id: string, on: boolean) {
    const op = this.operators.get(id);
    if (op) this.operators.set(id, { ...op, notifyRfqMatch: on });
  }
  async setOperatorSuspended(id: string, suspended: boolean) {
    const op = this.operators.get(id);
    if (op) this.operators.set(id, { ...op, suspended });
  }

  async createListing(
    l: Omit<Listing, "id" | "createdAt" | "status" | "views"> & {
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
          x.status !== "archived" && x.status !== "sold" &&
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
      views: 0,
      createdAt: now(),
    };
    this.listings.set(listing.id, listing);
    return listing;
  }
  async getListing(id: string) {
    return this.listings.get(id);
  }
  async bumpListingViews(id: string) {
    // Synchronous check+write — no await mid-mutation (QA-333).
    const l = this.listings.get(id);
    if (l) l.views += 1;
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
    verifiedOnly?: boolean;
    minRating?: number;
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
    let out = this.filterListings(filter);
    // QA-453/QA-454: sort="rating" + minRating both need the summary — one
    // batched read keeps the sync comparator/filter shapes intact.
    if (filter?.sort === "rating" || filter?.minRating !== undefined) {
      const summary = await this.ratingSummaryPerOperator(
        [...new Set(out.map((l) => l.operatorId))],
      );
      if (filter?.minRating !== undefined) {
        const min = filter.minRating;
        out = out.filter((l) => (summary[l.operatorId]?.avg ?? -1) >= min);
      }
      if (filter?.sort === "rating") {
        const rated = (l: Listing) => summary[l.operatorId] !== undefined;
        out.sort(
          (a, b) =>
            Number(rated(b)) - Number(rated(a)) ||
            (summary[b.operatorId]?.avg ?? 0) -
              (summary[a.operatorId]?.avg ?? 0) ||
            byNewest(a, b),
        );
      } else {
        out.sort(cmp);
      }
    } else {
      out.sort(cmp);
    }
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
    verifiedOnly?: boolean;
    minRating?: number;
    excludeSuspendedOps?: boolean;
    ids?: string[];
  }): Promise<number> {
    let rows = this.filterListings(filter);
    if (filter?.minRating !== undefined) {
      // QA-454: unrated ops drop out — same semantics as the SQL
      // subquery's NULL >= n.
      const summary = await this.ratingSummaryPerOperator(
        [...new Set(rows.map((l) => l.operatorId))],
      );
      const min = filter.minRating;
      rows = rows.filter((l) => (summary[l.operatorId]?.avg ?? -1) >= min);
    }
    return rows.length;
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
    verifiedOnly?: boolean;
    excludeSuspendedOps?: boolean;
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
    if (filter?.verifiedOnly) {
      // QA-436: EXISTS-parity with drizzle — a missing operator row hides.
      out = out.filter(
        (l) => this.operators.get(l.operatorId)?.verified === true,
      );
    }
    if (filter?.excludeSuspendedOps) {
      // QA-460: NOT EXISTS parity — only a KNOWN-suspended owner hides.
      out = out.filter(
        (l) => this.operators.get(l.operatorId)?.suspended !== true,
      );
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
          x.status !== "archived" && x.status !== "sold" &&
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
  async deleteListing(
    id: string,
    scope: { operatorId: string; vertical: string },
  ): Promise<boolean> {
    // Sync check-then-write — no yield before the delete (QA-333). Sold rows
    // keep the deal provenance — delete stays draft|archived only.
    const l = this.listings.get(id);
    if (
      !l ||
      l.operatorId !== scope.operatorId ||
      l.vertical !== scope.vertical ||
      (l.status !== "draft" && l.status !== "archived")
    ) {
      return false;
    }
    this.listings.delete(id);
    // FK `set null` parity with pg: RFQs and their match deliveries lose
    // the listing link, never the row.
    for (const [rid, r] of this.rfqs) {
      if (r.listingId === id) {
        this.rfqs.set(rid, { ...r, listingId: null, updatedAt: now() });
      }
    }
    for (const [rid, m] of this.rfqMatches) {
      const next = new Map(m);
      let dirty = false;
      for (const [opId, v] of next) {
        if (v.listingId === id) {
          next.set(opId, { ...v, listingId: null });
          dirty = true;
        }
      }
      if (dirty) this.rfqMatches.set(rid, next);
    }
    // FK `cascade` parity: a listing's reports die with it (QA-461/462).
    for (const [rid, r] of this.listingReports) {
      if (r.listingId === id) this.listingReports.delete(rid);
    }
    return true;
  }
  async listOperatorDirectory(input: {
    vertical: string;
    notExpiredByAttr?: { type: string; attr: string; asOf: string };
    limit?: number;
  }): Promise<{ operator: import("./types").Operator; activeCount: number }[]> {
    const counts = new Map<string, number>();
    for (const l of this.listings.values()) {
      if (l.vertical !== input.vertical || l.status !== "active") continue;
      if (input.notExpiredByAttr) {
        const { type, attr, asOf } = input.notExpiredByAttr;
        if (l.type === type) {
          const v = l.attributes[attr];
          if (typeof v === "string" && v < asOf) continue;
        }
      }
      counts.set(l.operatorId, (counts.get(l.operatorId) ?? 0) + 1);
    }
    const rows = [...counts.entries()].flatMap(([operatorId, n]) => {
      const operator = this.operators.get(operatorId);
      // QA-460: suspended operators leave the public directory entirely.
      return operator && !operator.suspended
        ? [{ operator, activeCount: n }]
        : [];
    });
    rows.sort(
      (a, b) =>
        b.activeCount - a.activeCount || a.operator.id.localeCompare(b.operator.id),
    );
    return rows.slice(0, input.limit ?? 96);
  }
  async countOperatorListings(operatorId: string, vertical?: string) {
    return [...this.listings.values()].filter(
      (l) =>
        l.operatorId === operatorId &&
        l.status !== "archived" && l.status !== "sold" &&
        (vertical === undefined || l.vertical === vertical),
    ).length;
  }
  async listListingCountsByOperator(operatorIds: string[], vertical?: string) {
    const want = new Set(operatorIds);
    const out: Record<string, number> = {};
    for (const l of this.listings.values()) {
      if (
        want.has(l.operatorId) &&
        l.status !== "archived" && l.status !== "sold" &&
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
      | "id"
      | "createdAt"
      | "updatedAt"
      | "status"
      | "accessToken"
      | "concierge"
      | "locale"
    > & {
      dedupeKey?: string;
      accessToken?: string;
      locale?: string;
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
    const { dedupeKey, accessToken, locale, ...rest } = r;
    void dedupeKey;
    // One stamp for both — separate now() calls can straddle a millisecond
    // and fake "amended since creation" on a never-edited row.
    const stamped = now();
    const rfq: Rfq = {
      ...rest,
      id: uid("rfq"),
      status: "open",
      concierge: false,
      accessToken: accessToken ?? crypto.randomUUID(),
      createdAt: stamped,
      updatedAt: stamped,
      locale: locale ?? "en",
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
    this.rfqs.set(id, { ...rfq, status, updatedAt: now() });
    return true;
  }
  async closeLiveRfqsForListing(listingId: string): Promise<Rfq[]> {
    // Synchronous check+write loop (QA-333) — no await between read and set.
    const closed: Rfq[] = [];
    for (const rfq of this.rfqs.values()) {
      if (rfq.listingId === listingId && LIVE_RFQ_STATUSES.has(rfq.status)) {
        const next = { ...rfq, status: "closed" as const, updatedAt: now() };
        this.rfqs.set(rfq.id, next);
        closed.push(next);
      }
    }
    return closed;
  }
  async extendRfqDeadline(id: string, dateTo: string): Promise<boolean> {
    const rfq = this.rfqs.get(id);
    // Same gate as drizzle — synchronous check+write (QA-333); the merge
    // keeps every other request field (QA-446).
    if (!rfq || !LIVE_RFQ_STATUSES.has(rfq.status)) return false;
    this.rfqs.set(id, {
      ...rfq,
      fields: { ...rfq.fields, dateTo },
      updatedAt: now(),
    });
    return true;
  }
  async setRfqPaused(id: string, paused: boolean): Promise<boolean> {
    const rfq = this.rfqs.get(id);
    // Synchronous check+write (QA-333) — matches the drizzle CAS exactly.
    if (!rfq) return false;
    if (paused) {
      if (!LIVE_RFQ_STATUSES.has(rfq.status) || rfq.pausedAt) return false;
      this.rfqs.set(id, { ...rfq, pausedAt: now(), updatedAt: now() });
      return true;
    }
    if (!rfq.pausedAt) return false;
    this.rfqs.set(id, { ...rfq, pausedAt: undefined, updatedAt: now() });
    return true;
  }
  async updateRfqFields(
    id: string,
    fields: Record<string, unknown>,
    dedupeKey: string,
  ): Promise<boolean> {
    const rfq = this.rfqs.get(id);
    // Same live gate as drizzle — synchronous check+write (QA-333). The
    // fields replace + dedupe re-key are one mutation, not interleavable.
    if (!rfq || !LIVE_RFQ_STATUSES.has(rfq.status)) return false;
    // Mirrors the partial unique index: the recomputed key collides only
    // with a DIFFERENT live twin — same error createRfq throws (QA-228).
    const hitId = this.rfqDedupe.get(dedupeKey);
    const hit = hitId ? this.rfqs.get(hitId) : undefined;
    if (hit && hit.id !== id && LIVE_RFQ_STATUSES.has(hit.status)) {
      throw new Error("duplicate key value violates unique constraint");
    }
    for (const [k, v] of this.rfqDedupe) {
      if (v === id) this.rfqDedupe.delete(k);
    }
    // QA-536: superseded field-map rung inside the same synchronous
    // mutation — the trail can never skip an edit the CAS admitted.
    const rungs = this.rfqAmendments.get(id) ?? [];
    rungs.unshift({
      id: crypto.randomUUID(),
      rfqId: id,
      fields: rfq.fields,
      amendedAt: now(),
    });
    this.rfqAmendments.set(id, rungs);
    this.rfqs.set(id, { ...rfq, fields, updatedAt: now() });
    this.rfqDedupe.set(dedupeKey, id);
    return true;
  }
  /** Delivered = matchVisible's rule on every holder, minus dismissals —
   *  the amend-notify set (QA-481). */
  async listRfqMatchOperatorIds(rfqId: string): Promise<string[]> {
    const out: string[] = [];
    for (const opId of this.rfqMatches.get(rfqId)?.keys() ?? []) {
      if (!this.matchVisible(rfqId, opId)) continue;
      if (this.rfqDismissed.has(`${rfqId}:${opId}`)) continue;
      out.push(opId);
    }
    return out;
  }
  async expediteRfq(id: string) {
    const rfq = this.rfqs.get(id);
    if (!rfq || rfq.concierge || !LIVE_RFQ_STATUSES.has(rfq.status)) {
      return { applied: false, matches: [] };
    }
    // Check-to-write is synchronous — a parallel call can't interleave the
    // flag set with the match flip (same QA-333 rule as every mutator).
    rfq.concierge = true;
    rfq.updatedAt = now();
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
    ids?: string[];
    buyerEmail?: string;
    operatorId?: string;
    listingId?: string;
    needsQuote?: boolean;
    dismissedOnly?: boolean;
    answeredOnly?: boolean;
    counteredOnly?: boolean;
    lostOnly?: boolean;
    vertical?: string;
    sort?: "deadline";
    limit?: number;
    offset?: number;
  }): Promise<Rfq[]> {
    let out = [...this.rfqs.values()];
    if (filter?.ids) {
      const want = new Set(filter.ids);
      out = out.filter((r) => want.has(r.id));
    }
    if (filter?.listingId)
      out = out.filter((r) => r.listingId === filter.listingId);
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
      out = out.filter((r) => {
        const visible =
          (r.listingId !== null && opListingIds.has(r.listingId)) ||
          this.matchVisible(r.id, opId);
        // dismissedOnly flips the QA-420 exclusion into a positive match —
        // the "Dismissed" inbox view (QA-421). Rows that also left the
        // inbox entirely still hide (visibility gate stays on both arms).
        return filter.dismissedOnly
          ? visible && this.rfqDismissed.has(`${r.id}:${opId}`)
          : visible && !this.rfqDismissed.has(`${r.id}:${opId}`);
      });
      // "Needs a quote" hides RFQs the operator already has a live quote
      // on (sent/accepted) — declined/withdrawn leave it needing action
      // (QA-402); "Answered" (QA-433) is the exact inverse, same live set.
      if (filter.needsQuote || filter.answeredOnly) {
        const quoted = new Set(
          [...this.quotes.values()]
            .filter(
              (q) =>
                q.operatorId === opId &&
                (q.status === "sent" || q.status === "accepted"),
            )
            .map((q) => q.rfqId),
        );
        out = out.filter((r) =>
          filter.answeredOnly ? quoted.has(r.id) : !quoted.has(r.id),
        );
      }
      // QA-513 "countered": the lead is hot — the buyer put a number on
      // the table and it hasn't been answered yet (revise clears it).
      if (filter.counteredOnly) {
        const countered = new Set(
          [...this.quotes.values()]
            .filter(
              (q) =>
                q.operatorId === opId &&
                q.status === "sent" &&
                q.counteredAt !== undefined,
            )
            .map((q) => q.rfqId),
        );
        out = out.filter((r) => countered.has(r.id));
      }
      // QA-537 "lost": the RFQ died AND this operator quoted on it —
      // the where-did-my-offers-die view ('spam' is moderation, not a loss).
      if (filter.lostOnly) {
        const quoted = new Set(
          [...this.quotes.values()]
            .filter((q) => q.operatorId === opId)
            .map((q) => q.rfqId),
        );
        out = out.filter(
          (r) =>
            quoted.has(r.id) &&
            (r.status === "closed" || r.status === "expired"),
        );
      }
    }
    // Operator inbox: concierge expedites sort first — the buyer paid for
    // immediate attention (QA-400); admin lists stay newest-first.
    // sort="deadline" (QA-443) orders user-scoped lists (operator or buyer
    // inbox) by the QA-442 liveness horizon — soonest-dying live row first;
    // terminal rows always trail live ones (QA-448: a dead deadline isn't
    // 'ending soon', it's gone).
    const deadlineSort =
      filter?.sort === "deadline" &&
      (filter?.operatorId !== undefined || filter?.buyerEmail !== undefined);
    // QA-520: an unanswered buyer counter outranks recency (but never a
    // paid concierge expedite) — the hottest lead shouldn't sink below
    // the fold. Always on for the op inbox; no-op when nothing's
    // countered. Same predicate as the ?f=countered filter.
    const counteredRfqIds =
      filter?.operatorId === undefined
        ? null
        : new Set(
            [...this.quotes.values()]
              .filter(
                (q) =>
                  q.operatorId === filter.operatorId &&
                  q.status === "sent" &&
                  q.counteredAt !== undefined,
              )
              .map((q) => q.rfqId),
          );
    const counteredArm = (r: Rfq) =>
      counteredRfqIds?.has(r.id) ? 0 : 1;
    out = out.sort((a, b) => {
      // Concierge stays the top rank wherever it's visible (operator
      // inbox) — a paid expedite outranks liveness too (QA-443 order).
      const conciergeArm = filter?.operatorId
        ? Number(b.concierge) - Number(a.concierge)
        : 0;
      const counterDiff = filter?.operatorId
        ? counteredArm(a) - counteredArm(b)
        : 0;
      const createdArm = b.createdAt.localeCompare(a.createdAt);
      if (deadlineSort) {
        const la = LIVE_RFQ_STATUSES.has(a.status) ? 0 : 1;
        const lb = LIVE_RFQ_STATUSES.has(b.status) ? 0 : 1;
        if (la !== lb) return la - lb;
        if (la === 0) {
          return (
            conciergeArm ||
            counterDiff ||
            rfqDeadlineAt(a).getTime() - rfqDeadlineAt(b).getTime() ||
            createdArm
          );
        }
        // Terminal group: parity with drizzle — concierge rank still
        // applies within it, then createdAt-desc (the deadline arm is
        // meaningless on dead rows, QA-448).
        return conciergeArm || counterDiff || createdArm;
      }
      return conciergeArm || counterDiff || createdArm;
    });
    if (filter?.offset) out = out.slice(filter.offset);
    if (filter?.limit !== undefined) out = out.slice(0, filter.limit);
    return out;
  }

  /** A match is visible once due — no sweep needed in memory mode. */
  private matchVisible(rfqId: string, operatorId: string): boolean {
    const m = this.rfqMatches.get(rfqId)?.get(operatorId);
    return !!m && (!m.deliverAt || m.deliverAt.getTime() <= Date.now());
  }

  /** QA-420 dismissed pairs `${rfqId}:${operatorId}` — per-operator inbox
   *  state, hidden from that operator's views only. */
  private rfqDismissed = new Set<string>();

  async dismissRfq(rfqId: string, operatorId: string): Promise<boolean> {
    const rfq = this.rfqs.get(rfqId);
    if (!rfq) return false;
    const owns =
      rfq.listingId !== null &&
      this.listings.get(rfq.listingId)?.operatorId === operatorId;
    if (!owns && !this.matchVisible(rfqId, operatorId)) return false;
    this.rfqDismissed.add(`${rfqId}:${operatorId}`);
    return true;
  }

  /** QA-421 undo: the pair's absence is the stranger-proof — Set.delete
   *  returns false when there was nothing to restore. */
  async undismissRfq(rfqId: string, operatorId: string): Promise<boolean> {
    return this.rfqDismissed.delete(`${rfqId}:${operatorId}`);
  }

  /** Still undelivered = deliverAt strictly in the future (matchVisible's
   *  inverse on the same rows — the concierge-delivery set). */
  async countRfqPendingMatches(rfqId: string): Promise<number> {
    const now = Date.now();
    let n = 0;
    for (const m of this.rfqMatches.get(rfqId)?.values() ?? []) {
      if (m.deliverAt && m.deliverAt.getTime() > now) n++;
    }
    return n;
  }

  /** Delivered = matchVisible's rule — due (or absent) deliverAt counts. */
  async countDeliveredMatches(rfqIds: string[]): Promise<Record<string, number>> {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const rfqId of rfqIds) {
      let n = 0;
      for (const m of this.rfqMatches.get(rfqId)?.values() ?? []) {
        if (!m.deliverAt || m.deliverAt.getTime() <= now) n++;
      }
      if (n) out[rfqId] = n;
    }
    return out;
  }

  async hasRfqMatch(rfqId: string, operatorId: string): Promise<boolean> {
    return this.matchVisible(rfqId, operatorId);
  }

  async markInboxSeen(operatorId: string): Promise<void> {
    const op = this.operators.get(operatorId);
    if (op) op.inboxSeenAt = now();
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
      // pg is ON CONFLICT (rfq_id, operator_id) DO NOTHING — a re-fan-out
      // (QA-481 amend) must not refresh an existing pair's deliverAt.
      if (!forRfq.has(r.operatorId)) {
        forRfq.set(r.operatorId, {
          listingId: r.listingId ?? null,
          ...(r.deliverAt ? { deliverAt: r.deliverAt } : {}),
        });
      }
      this.rfqMatches.set(r.rfqId, forRfq);
    }
    // Mirror markRfqMatched: only off the initial state, never resurrect.
    if (rows.length) {
      const rfq = this.rfqs.get(rows[0]!.rfqId);
      if (rfq && rfq.status === "open") {
        rfq.status = "matched";
        rfq.updatedAt = now();
      }
    }
  }

  async countRfqs(filter?: {
    buyerEmail?: string;
    operatorId?: string;
    needsQuote?: boolean;
    answeredOnly?: boolean;
    counteredOnly?: boolean;
    lostOnly?: boolean;
    listingId?: string;
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
      // A dismissed delayed match is no teaser either (QA-420).
      if (this.rfqDismissed.has(`${rfqId}:${operatorId}`)) continue;
      n++;
    }
    return n;
  }

  async createQuote(q: Omit<Quote, "id" | "createdAt" | "status" | "updatedAt">): Promise<Quote> {
    const n = now();
    const quote: Quote = { ...q, id: uid("quo"), status: "sent", createdAt: n, updatedAt: n };
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
      this.rfqs.set(rfq.id, { ...rfq, status: "quoted", updatedAt: now() });
    }
    return quote;
  }
  async getQuote(id: string) {
    return this.quotes.get(id);
  }
  async listQuotes(filter?: { rfqId?: string; operatorId?: string; ids?: string[]; rfqIds?: string[]; status?: Quote["status"] }): Promise<Quote[]> {
    let out = [...this.quotes.values()];
    if (filter?.rfqId) out = out.filter((q) => q.rfqId === filter.rfqId);
    if (filter?.operatorId) out = out.filter((q) => q.operatorId === filter.operatorId);
    if (filter?.status) out = out.filter((q) => q.status === filter.status);
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
  async countQuotes(filter?: { operatorId?: string; status?: Quote["status"]; since?: string; buyerSeen?: boolean; countered?: boolean }) {
    let out = [...this.quotes.values()];
    if (filter?.operatorId) out = out.filter((q) => q.operatorId === filter.operatorId);
    if (filter?.status) out = out.filter((q) => q.status === filter.status);
    if (filter?.since) out = out.filter((q) => q.createdAt >= filter.since!);
    if (filter?.buyerSeen) out = out.filter((q) => !!q.buyerSeenAt);
    // QA-517: a counter only counts while it waits — an answered one
    // (revise clears it; close transitions the row) is a done thing.
    if (filter?.countered)
      out = out.filter(
        (q) => q.status === "sent" && q.counteredAt !== undefined,
      );
    return out.length;
  }
  async countQuotesByDeclineReason(operatorId: string) {
    const out: Record<string, number> = {};
    for (const q of this.quotes.values()) {
      if (q.operatorId !== operatorId || q.status !== "declined") continue;
      const key = q.declineReason ?? "none";
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }
  async counterQuote(id: string, amount: number, note?: string) {
    const q = this.quotes.get(id);
    if (!q || q.status !== "sent" || q.counteredAt) return false;
    const stamp = now();
    // Deliberately no updatedAt bump — a counter isn't a revision of the
    // offer (the "updated" badge + stale-offer check ride that stamp).
    this.quotes.set(id, {
      ...q,
      counterAmount: amount,
      counteredAt: stamp,
      // QA-521: empty note stores nothing — the field stays absent.
      ...(note ? { counterMessage: note } : {}),
    });
    // QA-522: append the audit row — QA-333: synchronous with the CAS
    // above so a parallel caller can't split them.
    const rounds = this.counterRounds.get(id) ?? [];
    rounds.unshift({
      id: `round-${rounds.length}-${stamp}`,
      quoteId: id,
      rfqId: q.rfqId,
      amount,
      // Denormalized like pg: a revise may flip the quote's currency;
      // the counter was denominated in what it carried then.
      currency: q.currency,
      ...(note ? { note } : {}),
      outcome: "open",
      createdAt: stamp,
    });
    this.counterRounds.set(id, rounds);
    return true;
  }
  // QA-522: one resolver every clear path funnels through — flips the
  // live round's outcome; no-op when the quote has no open round.
  private resolveCounterRounds(id: string, outcome: CounterRoundOutcome) {
    const rounds = this.counterRounds.get(id);
    if (!rounds) return;
    const stamp = now();
    this.counterRounds.set(
      id,
      rounds.map((r) =>
        r.outcome === "open" ? { ...r, outcome, resolvedAt: stamp } : r,
      ),
    );
  }
  async listCounterRounds(quoteIds: string[]) {
    const out: CounterRound[] = [];
    for (const id of quoteIds) {
      const rounds = this.counterRounds.get(id);
      if (rounds) out.push(...rounds);
    }
    // Newest first — contract + drizzle parity.
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async listQuoteRevisions(quoteIds: string[]) {
    const out: QuoteRevision[] = [];
    for (const id of quoteIds) {
      const revs = this.quoteRevisions.get(id);
      if (revs) out.push(...revs);
    }
    // Newest first — contract + drizzle parity (same-ms ties keep their
    // unshift order, matching insert order).
    return out.sort((a, b) =>
      b.supersededAt === a.supersededAt
        ? 0
        : b.supersededAt.localeCompare(a.supersededAt),
    );
  }
  async listRfqAmendments(rfqIds: string[]) {
    const out: RfqAmendment[] = [];
    for (const id of rfqIds) {
      const rungs = this.rfqAmendments.get(id);
      if (rungs) out.push(...rungs);
    }
    // Newest first per RFQ — same-ms ties keep unshift (insert) order.
    return out.sort((a, b) =>
      b.amendedAt === a.amendedAt
        ? 0
        : b.amendedAt.localeCompare(a.amendedAt),
    );
  }
  async countCounterRoundsByOutcome(operatorId: string) {
    let accepted = 0;
    let resolved = 0;
    for (const q of this.quotes.values()) {
      if (q.operatorId !== operatorId) continue;
      for (const r of this.counterRounds.get(q.id) ?? []) {
        if (r.outcome === "open") continue;
        resolved++;
        if (r.outcome === "accepted") accepted++;
      }
    }
    return { accepted, resolved };
  }
  // QA-524: empty/whitespace clears — a note you can't empty is a note
  // you can't delete. Writes stay synchronous check-to-write (QA-333).
  async setRfqNote(operatorId: string, rfqId: string, note: string | null) {
    const trimmed = note?.trim() ?? "";
    let mine = this.rfqNotes.get(operatorId);
    if (!trimmed) {
      mine?.delete(rfqId);
      return null;
    }
    if (!mine) {
      mine = new Map();
      this.rfqNotes.set(operatorId, mine);
    }
    const row: RfqNote = { rfqId, note: trimmed, updatedAt: now() };
    mine.set(rfqId, row);
    return row;
  }
  async listRfqNotes(operatorId: string, rfqIds: string[]) {
    const mine = this.rfqNotes.get(operatorId);
    if (!mine) return [];
    const out: RfqNote[] = [];
    for (const id of rfqIds) {
      const row = mine.get(id);
      if (row) out.push(row);
    }
    return out;
  }
  async listQuoteTemplates(operatorId: string) {
    const mine = this.quoteTemplates.get(operatorId);
    if (!mine) return [];
    return [...mine.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async upsertQuoteTemplate(t: {
    operatorId: string;
    name: string;
    amount: number;
    message: string;
  }) {
    let mine = this.quoteTemplates.get(t.operatorId);
    if (!mine) {
      mine = new Map();
      this.quoteTemplates.set(t.operatorId, mine);
    }
    for (const row of mine.values()) {
      if (row.name === t.name) {
        const updated: QuoteTemplate = {
          ...row,
          amount: t.amount,
          message: t.message,
          updatedAt: now(),
        };
        mine.set(row.id, updated);
        return updated;
      }
    }
    const row: QuoteTemplate = {
      id: crypto.randomUUID(),
      operatorId: t.operatorId,
      name: t.name,
      amount: t.amount,
      message: t.message,
      createdAt: now(),
      updatedAt: now(),
    };
    mine.set(row.id, row);
    return row;
  }
  async deleteQuoteTemplate(operatorId: string, id: string) {
    return this.quoteTemplates.get(operatorId)?.delete(id) ?? false;
  }
  async clearQuoteCounter(id: string, outcome: "withdrawn" | "declined" = "withdrawn") {
    const q = this.quotes.get(id);
    if (!q || q.status !== "sent" || !q.counteredAt) return false;
    // QA-518: the buyer pulls their number off the table — a
    // re-countered round is a fresh round. (The QA-516 nudge stamp is
    // pg-only — the worker repo has no memory impl.)
    this.quotes.set(id, {
      ...q,
      counterAmount: undefined,
      counteredAt: undefined,
      counterMessage: undefined,
    });
    // QA-522: the round closed — the audit row records how.
    this.resolveCounterRounds(id, outcome);
    return true;
  }
  async setQuoteStatus(id: string, status: Quote["status"], expected: Quote["status"], opts?: { declineReason?: QuoteDeclineReason }) {
    const q = this.quotes.get(id);
    if (!q || q.status !== expected) return false;
    // Parity: pg bumps updated_at on every write (QA-445).
    this.quotes.set(id, {
      ...q,
      status,
      updatedAt: now(),
      ...(opts?.declineReason ? { declineReason: opts.declineReason } : {}),
    });
    // QA-522: leaving 'sent' ends any live counter round — accepted
    // mints the deal; everything else lapses as 'expired'.
    if (expected === "sent" && status !== "sent") {
      this.resolveCounterRounds(
        id,
        status === "accepted" ? "accepted" : "expired",
      );
    }
    return true;
  }

  // QA-439: same CAS gates as drizzle — check+write stays synchronous
  // (QA-333); createdAt is preserved so response-time stats can't be
  // backdated by edits.
  async reviseQuote(
    id: string,
    operatorId: string,
    patch: { amount: number; currency: string; message: string },
    opts?: { counterOutcome?: "answered" | "accepted" },
  ) {
    const q = this.quotes.get(id);
    if (!q || q.operatorId !== operatorId || q.status !== "sent") return null;
    const rfq = this.rfqs.get(q.rfqId);
    if (!rfq || !LIVE_RFQ_STATUSES.has(rfq.status)) return null;
    const stamp = now();
    const next: Quote = {
      ...q,
      amount: patch.amount,
      currency: patch.currency,
      message: patch.message,
      updatedAt: stamp,
      // QA-506: revised content is unseen — the buyer saw the old terms.
      buyerSeenAt: undefined,
      // QA-511: a revise answers the buyer's counter — next round.
      counterAmount: undefined,
      counteredAt: undefined,
      // QA-521: the note retires with the round too.
      counterMessage: undefined,
    };
    // QA-530: log the superseded terms BEFORE the overwrite — sync with
    // the CAS so a parallel revise can't split or skip a generation
    // (QA-333). unshift keeps the trail newest-first like pg's desc read.
    const revs = this.quoteRevisions.get(id) ?? [];
    revs.unshift({
      id: `rev-${revs.length}-${stamp}`,
      quoteId: id,
      rfqId: q.rfqId,
      amount: q.amount,
      currency: q.currency,
      ...(q.message ? { message: q.message } : {}),
      supersededAt: stamp,
    });
    this.quoteRevisions.set(id, revs);
    this.quotes.set(id, next);
    // QA-522: the counter was answered by new terms — or outright taken
    // when the revise IS the accept-counter close.
    this.resolveCounterRounds(id, opts?.counterOutcome ?? "answered");
    return next;
  }

  async markQuotesBuyerSeen(quoteIds: string[]) {
    const stamp = now();
    for (const id of quoteIds) {
      const q = this.quotes.get(id);
      if (q && !q.buyerSeenAt) this.quotes.set(id, { ...q, buyerSeenAt: stamp });
    }
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
      this.rfqs.set(r.id, { ...r, status: "expired", updatedAt: now() });
      for (const q of this.quotes.values()) {
        if (q.rfqId === r.id && q.status === "sent") {
          this.quotes.set(q.id, { ...q, status: "declined" });
          // QA-522: the request died under the counter — 'expired'.
          this.resolveCounterRounds(q.id, "expired");
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
    invoiceUrl?: string,
  ) {
    const deal = this.deals.get(id);
    if (!deal) return false;
    if (expectedIn && !expectedIn.includes(deal.invoiceStatus)) return false;
    this.deals.set(id, {
      ...deal,
      invoiceStatus: status,
      invoiceRef: ref ?? deal.invoiceRef,
      invoiceUrl: invoiceUrl ?? deal.invoiceUrl,
    });
    return true;
  }
  async rateDeal(id: string, rating: number): Promise<boolean> {
    const deal = this.deals.get(id);
    // Sync check-write — once-ever + in-range in one pass (QA-333).
    if (!deal || deal.buyerRating !== undefined || rating < 1 || rating > 5) {
      return false;
    }
    this.deals.set(id, {
      ...deal,
      buyerRating: rating,
      buyerRatedAt: new Date().toISOString(),
    });
    return true;
  }
  async rateDealByOperator(id: string, rating: number): Promise<boolean> {
    const deal = this.deals.get(id);
    // Sync check-write — once-ever + in-range in one pass (QA-333).
    if (!deal || deal.operatorRating !== undefined || rating < 1 || rating > 5) {
      return false;
    }
    this.deals.set(id, {
      ...deal,
      operatorRating: rating,
      operatorRatedAt: new Date().toISOString(),
    });
    return true;
  }
  async avgBuyerScores(
    emails: string[],
  ): Promise<Record<string, { avg: number; count: number }>> {
    const want = new Set(emails.map((e) => e.toLowerCase()));
    const acc = new Map<string, { sum: number; count: number }>();
    for (const d of this.deals.values()) {
      if (d.operatorRating === undefined) continue;
      const q = this.quotes.get(d.quoteId);
      const rfq = q ? this.rfqs.get(q.rfqId) : undefined;
      const email = rfq?.buyerEmail.toLowerCase();
      if (!email || !want.has(email)) continue;
      const a = acc.get(email) ?? { sum: 0, count: 0 };
      a.sum += d.operatorRating;
      a.count += 1;
      acc.set(email, a);
    }
    return Object.fromEntries(
      [...acc].map(([email, a]) => [
        email,
        { avg: a.sum / a.count, count: a.count },
      ]),
    );
  }
  async clearDealRating(id: string): Promise<boolean> {
    const deal = this.deals.get(id);
    // QA-458: sync check-write mirrors the pg gate — nothing to clear on
    // an unrated/missing row.
    if (!deal || deal.buyerRating === undefined) return false;
    this.deals.set(id, {
      ...deal,
      buyerRating: undefined,
      buyerRatedAt: undefined,
    });
    return true;
  }
  async ratingSummaryPerOperator(
    operatorIds: string[],
  ): Promise<Record<string, { avg: number; count: number }>> {
    const want = new Set(operatorIds);
    const acc = new Map<string, { sum: number; count: number }>();
    for (const d of this.deals.values()) {
      if (d.buyerRating === undefined || !want.has(d.operatorId)) continue;
      const cur = acc.get(d.operatorId) ?? { sum: 0, count: 0 };
      cur.sum += d.buyerRating;
      cur.count += 1;
      acc.set(d.operatorId, cur);
    }
    return Object.fromEntries(
      [...acc].map(([id, a]) => [id, { avg: a.sum / a.count, count: a.count }]),
    );
  }

  private listingReports = new Map<string, ListingReport>();

  async createListingReport(input: {
    listingId: string;
    reporterId: string;
    reason: string;
    note?: string;
  }): Promise<ListingReport | null> {
    // QA-461: one open flag per (listing, reporter) — a repeat returns null
    // (same dedupe contract the pg partial unique index enforces).
    for (const r of this.listingReports.values()) {
      if (
        r.listingId === input.listingId &&
        r.reporterId === input.reporterId &&
        r.status === "open"
      ) {
        return null;
      }
    }
    const row: ListingReport = {
      id: crypto.randomUUID(),
      listingId: input.listingId,
      reporterId: input.reporterId,
      reason: input.reason,
      note: input.note ?? null,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.listingReports.set(row.id, row);
    return row;
  }

  async listListingReports(opts?: {
    status?: ListingReportStatus;
    vertical?: string;
    reporterId?: string;
    limit?: number;
  }): Promise<ListingReport[]> {
    let out = [...this.listingReports.values()];
    if (opts?.status) out = out.filter((r) => r.status === opts.status);
    // QA-468: the buyer account page lists a reporter's own filings.
    if (opts?.reporterId)
      out = out.filter((r) => r.reporterId === opts.reporterId);
    // Reports carry no vertical — resolve through the listing (QA-461).
    if (opts?.vertical) {
      out = out.filter(
        (r) => this.listings.get(r.listingId)?.vertical === opts.vertical,
      );
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, opts?.limit ?? 200);
  }

  async resolveListingReport(id: string): Promise<boolean> {
    const r = this.listingReports.get(id);
    // Sync check-write mirrors the pg CAS — closed/missing rows return false.
    if (!r || r.status !== "open") return false;
    this.listingReports.set(id, {
      ...r,
      status: "dismissed",
      resolvedAt: new Date().toISOString(),
    });
    return true;
  }

  async resolveListingReportsByReporter(reporterId: string): Promise<number> {
    // QA-465: sync sweep, same write shape as ForListing — a blocked
    // buyer's flags were the weapon; they leave the queue with the block.
    let n = 0;
    for (const [id, r] of this.listingReports) {
      if (r.reporterId === reporterId && r.status === "open") {
        this.listingReports.set(id, {
          ...r,
          status: "dismissed",
          resolvedAt: now(),
        });
        n += 1;
      }
    }
    return n;
  }

  async resolveListingReportsForListing(listingId: string): Promise<number> {
    let n = 0;
    const at = new Date().toISOString();
    for (const r of this.listingReports.values()) {
      if (r.listingId === listingId && r.status === "open") {
        this.listingReports.set(r.id, {
          ...r,
          status: "dismissed",
          resolvedAt: at,
        });
        n += 1;
      }
    }
    return n;
  }

  private blockedEmails = new Map<string, BlockedEmail>(); // key: lower email
  private adminEvents = new Map<string, AdminEvent>();
  private rfqReports = new Map<string, RfqReport>();
  private quoteReports = new Map<string, QuoteReport>();

  async blockBuyerEmail(
    email: string,
    opts?: { reason?: string; by?: string },
  ): Promise<BlockedEmail> {
    // QA-463: sync check-write (QA-333) — a parallel double-block returns the
    // same live row instead of racing a second insert.
    const key = email.toLowerCase();
    const cur = this.blockedEmails.get(key);
    if (cur) return cur;
    const row: BlockedEmail = {
      id: crypto.randomUUID(),
      email: key,
      reason: opts?.reason ?? null,
      createdBy: opts?.by ?? null,
      createdAt: new Date().toISOString(),
    };
    this.blockedEmails.set(key, row);
    return row;
  }

  async unblockBuyerEmail(email: string): Promise<boolean> {
    return this.blockedEmails.delete(email.toLowerCase());
  }

  async isEmailBlocked(email: string): Promise<boolean> {
    return this.blockedEmails.has(email.toLowerCase());
  }

  async listBlockedEmails(): Promise<BlockedEmail[]> {
    return [...this.blockedEmails.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async createRfqReport(input: {
    rfqId: string;
    reporterId: string;
    reason: string;
    note?: string;
  }): Promise<RfqReport | null> {
    // QA-469: sync dedupe scan — a repeat OPEN flag from the same
    // operator returns null (route 409s); a dismissed flag re-arms
    // (QA-539, pg's partial unique).
    for (const r of this.rfqReports.values()) {
      if (
        r.rfqId === input.rfqId &&
        r.reporterId === input.reporterId &&
        r.status === "open"
      ) {
        return null;
      }
    }
    const row: RfqReport = {
      id: uid("rrep"),
      rfqId: input.rfqId,
      reporterId: input.reporterId,
      reason: input.reason,
      note: input.note ?? null,
      status: "open",
      createdAt: now(),
      resolvedAt: null,
    };
    this.rfqReports.set(row.id, row);
    return row;
  }

  async countRfqReports(rfqIds: string[]): Promise<Record<string, number>> {
    const want = new Set(rfqIds);
    const out: Record<string, number> = {};
    for (const r of this.rfqReports.values()) {
      // QA-539: open only — the badge tracks what still needs review.
      if (want.has(r.rfqId) && r.status === "open") {
        out[r.rfqId] = (out[r.rfqId] ?? 0) + 1;
      }
    }
    return out;
  }

  async listRfqReports(filter: {
    status?: RfqReportStatus;
    vertical?: string;
    rfqId?: string;
    limit?: number;
  }): Promise<RfqReport[]> {
    // Reports carry no vertical — scope through the RFQ (drizzle joins).
    const rows = [...this.rfqReports.values()].filter((r) => {
      if (filter.status !== undefined && r.status !== filter.status) {
        return false;
      }
      if (filter.rfqId !== undefined && r.rfqId !== filter.rfqId) return false;
      if (filter.vertical !== undefined) {
        const rfq = this.rfqs.get(r.rfqId);
        if (!rfq || rfq.vertical !== filter.vertical) return false;
      }
      return true;
    });
    // Same-ms writes: pg's microsecond stamp keeps insert order; memory
    // ties break by later-insert-first (newest-first, QA-467 parity).
    return rows
      .map((r, i) => ({ r, i }))
      .sort(
        (a, b) =>
          b.r.createdAt.localeCompare(a.r.createdAt) || b.i - a.i,
      )
      .map((x) => x.r)
      .slice(0, filter.limit ?? 100);
  }

  private resolveRfqReports(pred: (r: RfqReport) => boolean): number {
    let n = 0;
    for (const r of this.rfqReports.values()) {
      if (r.status === "open" && pred(r)) {
        r.status = "dismissed";
        r.resolvedAt = now();
        n++;
      }
    }
    return n;
  }

  async resolveRfqReport(id: string): Promise<boolean> {
    return this.resolveRfqReports((r) => r.id === id) > 0;
  }

  async resolveRfqReportsForRfq(rfqId: string): Promise<number> {
    return this.resolveRfqReports((r) => r.rfqId === rfqId);
  }

  async resolveRfqReportsByReporter(reporterId: string): Promise<number> {
    return this.resolveRfqReports((r) => r.reporterId === reporterId);
  }

  async createQuoteReport(input: {
    quoteId: string;
    reporterEmail: string;
    reason: string;
    note?: string;
  }): Promise<QuoteReport | null> {
    // QA-529: sync dedupe scan (QA-333) — a repeat OPEN flag from the
    // same address returns null (route 409s); dismissed re-arms.
    const want = input.reporterEmail.toLowerCase();
    for (const r of this.quoteReports.values()) {
      if (
        r.quoteId === input.quoteId &&
        r.reporterEmail.toLowerCase() === want &&
        r.status === "open"
      ) {
        return null;
      }
    }
    const row: QuoteReport = {
      id: uid("qrep"),
      quoteId: input.quoteId,
      reporterEmail: input.reporterEmail,
      reason: input.reason,
      note: input.note ?? null,
      status: "open",
      createdAt: now(),
      resolvedAt: null,
    };
    this.quoteReports.set(row.id, row);
    return row;
  }

  async listQuoteReports(opts?: {
    status?: QuoteReport["status"];
    vertical?: string;
    reporterEmail?: string;
    limit?: number;
  }): Promise<QuoteReport[]> {
    const reporter = opts?.reporterEmail?.toLowerCase();
    const rows = [...this.quoteReports.values()].filter((r) => {
      if (opts?.status !== undefined && r.status !== opts.status) return false;
      if (reporter !== undefined && r.reporterEmail.toLowerCase() !== reporter)
        return false;
      if (opts?.vertical !== undefined) {
        // Reports carry no vertical — scope through quote→rfq (drizzle joins).
        const quote = this.quotes.get(r.quoteId);
        const rfq = quote ? this.rfqs.get(quote.rfqId) : undefined;
        if (!rfq || rfq.vertical !== opts.vertical) return false;
      }
      return true;
    });
    // Newest-first; same-ms ties break later-insert-first (QA-467 parity).
    return rows
      .map((r, i) => ({ r, i }))
      .sort(
        (a, b) =>
          b.r.createdAt.localeCompare(a.r.createdAt) || b.i - a.i,
      )
      .map((x) => x.r)
      .slice(0, opts?.limit ?? 100);
  }

  async resolveQuoteReport(id: string): Promise<boolean> {
    // CAS on 'open' — sync check-write (QA-333): a repeat dismiss 409s.
    const r = this.quoteReports.get(id);
    if (!r || r.status !== "open") return false;
    this.quoteReports.set(id, { ...r, status: "dismissed", resolvedAt: now() });
    return true;
  }

  async resolveQuoteReportsByReporter(email: string): Promise<number> {
    const want = email.toLowerCase();
    let n = 0;
    for (const [id, r] of this.quoteReports) {
      if (r.status === "open" && r.reporterEmail.toLowerCase() === want) {
        this.quoteReports.set(id, {
          ...r,
          status: "dismissed",
          resolvedAt: now(),
        });
        n++;
      }
    }
    return n;
  }

  async logAdminEvent(
    e: Omit<AdminEvent, "id" | "createdAt">,
  ): Promise<AdminEvent> {
    // QA-467: append-only — one row per enforcement write, never updated.
    const row: AdminEvent = { ...e, id: uid("aev"), createdAt: now() };
    this.adminEvents.set(row.id, row);
    return row;
  }

  async listAdminEvents(filter: {
    vertical?: string;
    limit?: number;
  }): Promise<AdminEvent[]> {
    let rows = [...this.adminEvents.values()];
    if (filter.vertical) rows = rows.filter((r) => r.vertical === filter.vertical);
    // Same-ms writes: pg's microsecond stamp keeps insert order; memory
    // ties break by later-insert-first (newest-first feed, QA-467).
    rows = rows
      .map((r, i) => ({ r, i }))
      .sort(
        (a, b) =>
          b.r.createdAt.localeCompare(a.r.createdAt) || b.i - a.i,
      )
      .map((x) => x.r);
    return rows.slice(0, filter.limit ?? 50);
  }

  async spamBuyerRfqs(email: string, vertical: string): Promise<number> {
    // QA-464: sync check-write per row (QA-333) — only live rows flip;
    // terminal RFQs stay untouched, same gate as the per-row spam mark.
    const key = email.toLowerCase();
    let n = 0;
    for (const [id, r] of this.rfqs) {
      if (
        r.vertical === vertical &&
        r.buyerEmail.toLowerCase() === key &&
        (r.status === "open" || r.status === "matched" || r.status === "quoted")
      ) {
        this.rfqs.set(id, { ...r, status: "spam", updatedAt: now() });
        n += 1;
      }
    }
    return n;
  }

  /** QA-543: one synchronous sweep — every surface that can carry the
   *  mailbox scrubbed/deleted before any await can interleave (QA-333).
   *  Tombstones are `del_<rowId>@deleted.invalid`: unique per row so no
   *  dedupe/token index can collide, unguessable like the ids they wrap. */
  async deleteBuyerData(
    email: string,
    vertical: string,
  ): Promise<BuyerDeleteResult> {
    const key = email.toLowerCase();
    const tomb = (id: string) => `del_${id}@deleted.invalid`;
    const scrubFields = (
      fields: Record<string, unknown>,
      id: string,
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        out[k] = typeof v === "string" && v.toLowerCase() === key ? tomb(id) : v;
      }
      return out;
    };
    const out: BuyerDeleteResult = {
      rfqs: 0,
      alerts: 0,
      quoteReports: 0,
      counterScrubbed: 0,
      amendmentsScrubbed: 0,
      pendingJobs: 0,
      userDeleted: false,
    };
    const myRfqIds = new Set<string>();
    for (const [id, r] of this.rfqs) {
      if (r.vertical !== vertical || r.buyerEmail.toLowerCase() !== key) continue;
      myRfqIds.add(id);
      this.rfqs.set(id, {
        ...r,
        buyerEmail: tomb(id),
        accessToken: `del-${id}`,
        status: LIVE_RFQ_STATUSES.has(r.status) ? "closed" : r.status,
        fields: scrubFields(r.fields, id),
        updatedAt: now(),
      });
      out.rfqs += 1;
    }
    // dedupeKey lives only in the index map (rows don't carry it) — re-key
    // to the tombstone so a re-file re-mints instead of hitting the dead
    // key. Snapshot the moves first: mutating a Map mid-iteration would
    // re-visit the just-inserted tombstone and loop forever.
    const dedupeMoves: [string, string][] = [];
    for (const [dk, rid] of this.rfqDedupe) {
      if (myRfqIds.has(rid)) dedupeMoves.push([dk, rid]);
    }
    for (const [dk, rid] of dedupeMoves) {
      this.rfqDedupe.delete(dk);
      this.rfqDedupe.set(`del-${rid}`, rid);
    }
    for (const [id, a] of this.searchAlertRows) {
      if (a.vertical === vertical && a.email.toLowerCase() === key) {
        this.searchAlertRows.delete(id);
        out.alerts += 1;
      }
    }
    // The iface rows carry no dedupeKey — sweep orphan index entries for
    // the just-deleted alerts so a re-subscribe can't hit a stale hit.
    for (const [dk, aid] of this.searchAlertDedupe) {
      if (!this.searchAlertRows.has(aid)) this.searchAlertDedupe.delete(dk);
    }
    for (const [id, rep] of this.quoteReports) {
      if (rep.reporterEmail.toLowerCase() !== key) continue;
      const quote = this.quotes.get(rep.quoteId);
      if (quote && this.rfqs.get(quote.rfqId)?.vertical === vertical) {
        this.quoteReports.set(id, { ...rep, reporterEmail: tomb(rep.id) });
        out.quoteReports += 1;
      }
    }
    for (const [id, q] of this.quotes) {
      if (!myRfqIds.has(q.rfqId)) continue;
      if (q.counterMessage) {
        this.quotes.set(id, { ...q, counterMessage: undefined });
        out.counterScrubbed += 1;
      }
      const rounds = this.counterRounds.get(id);
      if (rounds?.some((r) => r.note)) {
        this.counterRounds.set(
          id,
          rounds.map((r) => (r.note ? { ...r, note: undefined } : r)),
        );
        out.counterScrubbed += 1;
      }
    }
    for (const rfqId of myRfqIds) {
      const amend = this.rfqAmendments.get(rfqId);
      if (amend) {
        this.rfqAmendments.set(
          rfqId,
          amend.map((a) => ({ ...a, fields: scrubFields(a.fields, a.id) })),
        );
        out.amendmentsScrubbed += amend.length;
      }
    }
    // Memory mode runs no job queue — fan-out is direct (QA-89).
    for (const [id, u] of this.users) {
      if (u.role === "buyer" && u.email.toLowerCase() === key) {
        this.users.delete(id);
        // pg cascades the buyer's own filed flags on users.id — parity:
        for (const [rid, rep] of this.listingReports) {
          if (rep.reporterId === id) this.listingReports.delete(rid);
        }
        for (const [rid, rep] of this.rfqReports) {
          if (rep.reporterId === id) this.rfqReports.delete(rid);
        }
        out.userDeleted = true;
      }
    }
    const ev: AdminEvent = {
      id: uid("aev"),
      event: "buyer_data_deleted",
      targetType: "buyer",
      // Random tombstone label — the audit feed must not carry the address
      // that was just deleted (that would defeat the scrub).
      targetId: `del_${crypto.randomUUID().slice(0, 8)}`,
      meta: out as unknown as Record<string, unknown>,
      vertical,
      createdAt: now(),
    };
    this.adminEvents.set(ev.id, ev);
    return out;
  }

  /** QA-544: the mailbox's whole record tree, read-only — same surfaces
   *  deleteBuyerData sweeps. Composed over the public reads (which already
   *  encode scoping/order semantics) plus the private stores only where a
   *  keyed read exists nowhere else. */
  async exportBuyerData(email: string, vertical: string): Promise<BuyerExport> {
    const key = email.toLowerCase();
    const rfqs = await this.listRfqs({
      buyerEmail: key,
      vertical,
      limit: 200,
    });
    const rfqIds = rfqs.map((r) => r.id);
    const [amendments, quotes] = await Promise.all([
      this.listRfqAmendments(rfqIds),
      this.listQuotes({ rfqIds }),
    ]);
    const quoteIds = quotes.map((q) => q.id);
    const [counterRounds, revisions, deals, searchAlerts, quoteReports, user] =
      await Promise.all([
        this.listCounterRounds(quoteIds),
        this.listQuoteRevisions(quoteIds),
        this.listDeals({ quoteIds }),
        this.listSearchAlerts({ email: key, vertical }),
        this.listQuoteReports({ reporterEmail: key, vertical, limit: 500 }),
        this.findUserByEmail(key),
      ]);
    const listingReports = user
      ? await this.listListingReports({ reporterId: user.id })
      : [];
    const dealByQuote = new Map(deals.map((d) => [d.quoteId, d]));
    return {
      email: key,
      vertical,
      exportedAt: now(),
      user,
      rfqs: rfqs.map((rfq) => ({
        rfq,
        amendments: amendments.filter((a) => a.rfqId === rfq.id),
        quotes: quotes
          .filter((q) => q.rfqId === rfq.id)
          .map((quote) => ({
            quote,
            counterRounds: counterRounds.filter((r) => r.quoteId === quote.id),
            revisions: revisions.filter((r) => r.quoteId === quote.id),
            deal: dealByQuote.get(quote.id),
          })),
      })),
      searchAlerts,
      quoteReports,
      listingReports,
    };
  }

  async listDeals(filter?: {
    operatorId?: string;
    vertical?: string;
    quoteIds?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Deal[]> {
    let out = [...this.deals.values()];
    if (filter?.quoteIds !== undefined) {
      const want = new Set(filter.quoteIds);
      out = out.filter((d) => want.has(d.quoteId));
    }
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
    // Enrich copies — never leak store refs with extra fields mutated on.
    return out.map((d) => {
      const q = this.quotes.get(d.quoteId);
      const r = q ? this.rfqs.get(q.rfqId) : undefined;
      return {
        ...d,
        rfqId: r?.id,
        buyerEmail: r?.buyerEmail,
        listingTitle: r?.listingId
          ? this.listings.get(r.listingId)?.title
          : undefined,
      };
    });
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

  // --- saved-search alerts (QA-403) --------------------------------------

  private searchAlertRows = new Map<string, SearchAlert>();
  private searchAlertDedupe = new Map<string, string>(); // dedupeKey -> alertId

  async createSearchAlert(input: {
    vertical: string;
    email: string;
    params: Record<string, unknown>;
    token: string;
    dedupeKey: string;
    freq?: SearchAlert["freq"];
    locale?: string;
  }): Promise<{ alert: SearchAlert; created: boolean }> {
    const email = input.email.toLowerCase();
    const hitId = this.searchAlertDedupe.get(input.dedupeKey);
    if (hitId) {
      // Re-subscribe: rotate token (old emailed links die); a dead row
      // ('off' or 'paused', QA-542) re-opens to 'pending' so re-arming
      // always passes the confirm mail; 'active'/'pending' keep status.
      // Sync between the read and the writes (no await) — see createRfq dedupe.
      const row = this.searchAlertRows.get(hitId);
      if (row) {
        row.token = input.token;
        row.email = email;
        row.params = input.params;
        row.freq = input.freq ?? "instant";
        if (input.locale) row.locale = input.locale;
        if (row.status === "off" || row.status === "paused")
          row.status = "pending";
        return { alert: row, created: false };
      }
    }
    const alert: SearchAlert = {
      id: uid("sa"),
      vertical: input.vertical,
      email,
      params: input.params,
      token: input.token,
      status: "pending",
      pendingIds: [],
      lastAlertedAt: null,
      createdAt: now(),
      freq: input.freq ?? "instant",
      locale: input.locale ?? "en",
    };
    this.searchAlertRows.set(alert.id, alert);
    this.searchAlertDedupe.set(input.dedupeKey, alert.id);
    return { alert, created: true };
  }

  async confirmSearchAlert(token: string): Promise<SearchAlert | null> {
    for (const row of this.searchAlertRows.values()) {
      if (row.token === token) {
        if (row.status !== "pending") return null;
        row.status = "active";
        return row;
      }
    }
    return null;
  }

  async unsubscribeSearchAlert(token: string): Promise<SearchAlert | null> {
    for (const row of this.searchAlertRows.values()) {
      if (row.token === token) {
        if (row.status === "off") return null;
        row.status = "off";
        return row;
      }
    }
    return null;
  }

  async setSearchAlertStatus(
    id: string,
    to: "active" | "paused",
    from: SearchAlert["status"][],
  ): Promise<SearchAlert | null> {
    const row = this.searchAlertRows.get(id);
    if (!row || !from.includes(row.status)) return null;
    row.status = to;
    return row;
  }

  async listSearchAlerts(filter: {
    vertical: string;
    status?: SearchAlert["status"];
    email?: string;
    watchListingId?: string;
  }): Promise<SearchAlert[]> {
    return [...this.searchAlertRows.values()].filter(
      (r) =>
        r.vertical === filter.vertical &&
        (filter.status === undefined || r.status === filter.status) &&
        (filter.email === undefined || r.email === filter.email) &&
        (filter.watchListingId === undefined ||
          r.params["watch"] === filter.watchListingId),
    );
  }

  async countSearchAlertsByWatch(
    vertical: string,
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of this.searchAlertRows.values()) {
      const watch = r.params["watch"];
      if (
        r.vertical === vertical &&
        r.status === "active" &&
        typeof watch === "string" &&
        watch
      ) {
        out[watch] = (out[watch] ?? 0) + 1;
      }
    }
    return out;
  }

  async countRfqsPerListing(
    operatorId: string,
    vertical: string,
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of this.rfqs.values()) {
      if (r.vertical !== vertical || r.status === "spam" || !r.listingId)
        continue;
      if (this.listings.get(r.listingId)?.operatorId !== operatorId) continue;
      out[r.listingId] = (out[r.listingId] ?? 0) + 1;
    }
    return out;
  }

  async appendSearchAlertPending(alertId: string, listingId: string) {
    const row = this.searchAlertRows.get(alertId);
    if (row && !row.pendingIds.includes(listingId))
      row.pendingIds.push(listingId);
  }

  async countDealsPerOperator(
    operatorIds: string[],
    vertical: string,
  ): Promise<Record<string, number>> {
    const want = new Set(operatorIds);
    const out: Record<string, number> = {};
    for (const d of this.deals.values()) {
      const q = this.quotes.get(d.quoteId);
      if (!q || !want.has(q.operatorId)) continue;
      // Deals carry no vertical — resolve through the parent RFQ.
      if (this.rfqs.get(q.rfqId)?.vertical !== vertical) continue;
      out[q.operatorId] = (out[q.operatorId] ?? 0) + 1;
    }
    return out;
  }

  async avgResponseHoursPerOperator(
    operatorIds: string[],
    vertical: string,
  ): Promise<Record<string, number>> {
    const want = new Set(operatorIds);
    const sum: Record<string, number> = {};
    const n: Record<string, number> = {};
    for (const q of this.quotes.values()) {
      if (!want.has(q.operatorId)) continue;
      const rfq = this.rfqs.get(q.rfqId);
      if (rfq?.vertical !== vertical) continue;
      sum[q.operatorId] =
        (sum[q.operatorId] ?? 0) +
        (Date.parse(q.createdAt) - Date.parse(rfq.createdAt)) / 3_600_000;
      n[q.operatorId] = (n[q.operatorId] ?? 0) + 1;
    }
    const out: Record<string, number> = {};
    for (const id of Object.keys(n)) out[id] = sum[id]! / n[id]!;
    return out;
  }

  async markSearchAlerted(id: string) {
    const row = this.searchAlertRows.get(id);
    if (row) {
      row.lastAlertedAt = now();
      row.pendingIds = [];
    }
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
