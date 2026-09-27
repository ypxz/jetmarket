/**
 * Postgres-backed Repo over @jetmarket/db (Drizzle). Selected by getRepo()
 * when REPO=postgres or DATABASE_URL is set. Conventions:
 *  - money: db stores *_minor (cents); the Repo interface uses dollar amounts
 *  - timestamps: db Date -> ISO strings
 *  - rfqs.status db "new" -> interface "open"; db also has matched/spam
 *  - deals has no operatorId/amount columns — joined from the parent quote
 */
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { createDb, expireStaleRfqs, schema, type Db } from "@jetmarket/db";
import type {
  Deal,
  Listing,
  ListingStatus,
  ListingType,
  Operator,
  Plan,
  Quote,
  QuoteStatus,
  Repo,
  Rfq,
  RfqStatus,
  Subscription,
  User,
  UserRole,
} from "./types";

const {
  users,
  operators,
  listings,
  rfqs,
  rfqMatches,
  quotes,
  deals,
  subscriptions,
} = schema;

const iso = (d: Date | null | undefined): string =>
  (d ?? new Date()).toISOString();
const minor = (usd: number): number => Math.round(usd * 100);

function toUser(r: typeof users.$inferSelect): User {
  return {
    id: r.id,
    email: r.email,
    role: r.role as UserRole,
    createdAt: iso(r.createdAt),
  };
}
function toOperator(r: typeof operators.$inferSelect): Operator {
  return {
    id: r.id,
    userId: r.userId,
    name: r.name,
    baseAirport: r.baseAirport ?? "",
    fleetSummary: r.fleetSummary ?? "",
    verified: r.verified,
    plan: r.plan as Plan,
    createdAt: iso(r.createdAt),
  };
}
function toListing(r: typeof listings.$inferSelect): Listing {
  return {
    id: r.id,
    operatorId: r.operatorId,
    vertical: r.vertical,
    type: r.type as ListingType,
    title: r.title,
    attributes: r.attributes,
    price: (r.priceMinor ?? 0) / 100,
    currency: r.currency,
    status: r.status as ListingStatus,
    photos: r.photos,
    createdAt: iso(r.createdAt),
  };
}
function toRfq(r: typeof rfqs.$inferSelect): Rfq {
  return {
    id: r.id,
    vertical: r.vertical,
    listingId: r.listingId ?? "",
    buyerEmail: r.buyerEmail,
    accessToken: r.accessToken,
    fields: r.fields,
    status: (r.status === "new" ? "open" : r.status) as RfqStatus,
    createdAt: iso(r.createdAt),
  };
}
function toQuote(r: typeof quotes.$inferSelect): Quote {
  return {
    id: r.id,
    rfqId: r.rfqId,
    operatorId: r.operatorId,
    amount: r.amountMinor / 100,
    currency: r.currency,
    message: r.message ?? "",
    status: r.status as QuoteStatus,
    createdAt: iso(r.createdAt),
  };
}
function toSubscription(r: typeof subscriptions.$inferSelect): Subscription {
  return {
    id: r.id,
    operatorId: r.operatorId,
    plan: r.plan as Plan,
    status: r.status as Subscription["status"],
    currentPeriodEnd: iso(r.currentPeriodEnd),
    ...(r.lastEventAt != null ? { lastEventAt: r.lastEventAt } : {}),
  };
}

type DealRow = typeof deals.$inferSelect;
type QuoteRow = typeof quotes.$inferSelect;
function toDeal(d: DealRow, q: QuoteRow): Deal {
  return {
    id: d.id,
    quoteId: d.quoteId,
    operatorId: q.operatorId,
    amount: q.amountMinor / 100,
    feePct: d.feePct,
    feeAmount: d.feeAmountMinor / 100,
    invoiceStatus: d.invoiceStatus as Deal["invoiceStatus"],
    invoiceRef: d.invoiceRef ?? undefined,
    closedAt: iso(d.closedAt),
  };
}


const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Non-uuid ids can only come from non-db impls/tests — miss, don't 22P02. */
const isUuid = (v: string) => UUID_RE.test(v);

interface ListingFilter {
  operatorId?: string;
  status?: ListingStatus;
  type?: ListingType;
  vertical?: string;
  query?: string;
  facets?: Record<string, string>;
  facetRanges?: { key: string; min?: number; max?: number }[];
}

/** Shared WHERE builder so listListings/countListings never drift apart.
 *  Facet equality runs in SQL (`attributes ->> k = v`) — required for
 *  limit/offset to paginate the same set the filters describe. */
function listingConds(filter?: ListingFilter) {
  const conds = [];
  if (filter?.operatorId) conds.push(eq(listings.operatorId, filter.operatorId));
  if (filter?.status) conds.push(eq(listings.status, filter.status));
  if (filter?.type) conds.push(eq(listings.type, filter.type));
  if (filter?.vertical) conds.push(eq(listings.vertical, filter.vertical));
  if (filter?.query) {
    // Escape LIKE metachars — user input must match literally ("100%" must
    // not behave like a wildcard pattern).
    const esc = filter.query.replace(/[%_\\]/g, (m) => `\\${m}`);
    const q = `%${esc}%`;
    // match title or any stringified attribute value
    conds.push(
      or(ilike(listings.title, q), sql`${listings.attributes}::text ilike ${q}`)!,
    );
  }
  if (filter?.facets) {
    for (const [k, v] of Object.entries(filter.facets)) {
      if (!v) continue;
      conds.push(sql`${listings.attributes} ->> ${k} = ${v}`);
    }
  }
  if (filter?.facetRanges) {
    for (const r of filter.facetRanges) {
      // `price` is a real column; everything else lives in attributes jsonb.
      // The regex guard keeps non-numeric attribute strings from failing the
      // ::numeric cast — they simply never satisfy a range (memory impl parity).
      if (r.key === "price") {
        // listListings exposes `price` in major units; the column stores minor.
        if (r.min !== undefined) conds.push(gte(listings.priceMinor, Math.ceil(r.min * 100)));
        if (r.max !== undefined) conds.push(lte(listings.priceMinor, Math.floor(r.max * 100)));
        continue;
      }
      const num = sql`case when ${listings.attributes} ->> ${r.key} ~ '^-?[0-9]+(\\.[0-9]+)?$' then (${listings.attributes} ->> ${r.key})::numeric end`;
      if (r.min !== undefined) conds.push(sql`${num} >= ${r.min}`);
      if (r.max !== undefined) conds.push(sql`${num} <= ${r.max}`);
    }
  }
  return conds.length ? and(...conds) : undefined;
}

export class DrizzleRepo implements Repo {
  constructor(private db: Db) {}

  async createUser(email: string, role: UserRole = "buyer"): Promise<User> {
    const normalized = email.toLowerCase();
    const existing = await this.findUserByEmail(normalized);
    if (existing) return existing;
    // onConflictDoNothing keeps concurrent sign-ups on the same email from
    // erroring on the unique constraint; the re-read returns the winner's row.
    await this.db
      .insert(users)
      .values({ email: normalized, role })
      .onConflictDoNothing({ target: users.email });
    const user = await this.findUserByEmail(normalized);
    if (!user) throw new Error("createUser: insert raced and winner vanished");
    return user;
  }
  async findUserByEmail(email: string): Promise<User | undefined> {
    const [r] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return r ? toUser(r) : undefined;
  }
  async getUser(id: string): Promise<User | undefined> {
    if (!isUuid(id)) return undefined;
    const [r] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return r ? toUser(r) : undefined;
  }

  async upsertOperator(
    o: Omit<Operator, "id" | "createdAt"> & { id?: string },
  ): Promise<Operator> {
    const values = {
      userId: o.userId,
      name: o.name,
      baseAirport: o.baseAirport,
      fleetSummary: o.fleetSummary,
      verified: o.verified,
      plan: o.plan,
    };
    if (o.id) {
      const [r] = await this.db
        .insert(operators)
        .values({ id: o.id, ...values })
        .onConflictDoUpdate({ target: operators.id, set: values })
        .returning();
      return toOperator(r!);
    }
    // upsert by userId (one operator profile per user)
    const prev = await this.getOperatorByUserId(o.userId);
    if (prev) {
      const [r] = await this.db
        .update(operators)
        .set(values)
        .where(eq(operators.id, prev.id))
        .returning();
      return toOperator(r!);
    }
    const [r] = await this.db.insert(operators).values(values).returning();
    return toOperator(r!);
  }
  async getOperator(id: string): Promise<Operator | undefined> {
    if (!isUuid(id)) return undefined;
    const [r] = await this.db
      .select()
      .from(operators)
      .where(eq(operators.id, id))
      .limit(1);
    return r ? toOperator(r) : undefined;
  }
  async getOperatorByUserId(userId: string): Promise<Operator | undefined> {
    if (!isUuid(userId)) return undefined;
    const [r] = await this.db
      .select()
      .from(operators)
      .where(eq(operators.userId, userId))
      .limit(1);
    return r ? toOperator(r) : undefined;
  }
  async listOperators(filter?: {
    limit?: number;
    offset?: number;
  }): Promise<Operator[]> {
    let q = this.db.select().from(operators).$dynamic();
    if (filter?.limit !== undefined) q = q.limit(filter.limit);
    if (filter?.offset) q = q.offset(filter.offset);
    return (await q).map(toOperator);
  }
  async countOperators(): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(operators);
    return r?.n ?? 0;
  }
  async setOperatorVerified(id: string, verified: boolean): Promise<void> {
    await this.db
      .update(operators)
      .set({ verified })
      .where(eq(operators.id, id));
  }
  async setOperatorPlan(id: string, plan: Plan): Promise<void> {
    await this.db.update(operators).set({ plan }).where(eq(operators.id, id));
  }

  async createListing(
    l: Omit<Listing, "id" | "createdAt" | "status"> & {
      status?: ListingStatus;
    },
  ): Promise<Listing> {
    const [r] = await this.db
      .insert(listings)
      .values({
        operatorId: l.operatorId,
        vertical: l.vertical,
        type: l.type,
        title: l.title,
        attributes: l.attributes,
        priceMinor: minor(l.price),
        currency: l.currency,
        status: l.status ?? "active",
        photos: l.photos,
      })
      .returning();
    return toListing(r!);
  }
  async getListing(id: string): Promise<Listing | undefined> {
    if (!isUuid(id)) return undefined;
    const [r] = await this.db
      .select()
      .from(listings)
      .where(eq(listings.id, id))
      .limit(1);
    return r ? toListing(r) : undefined;
  }
  async listListings(filter?: ListingFilter & {
    limit?: number;
    offset?: number;
  }): Promise<Listing[]> {
    let q = this.db
      .select()
      .from(listings)
      .where(listingConds(filter))
      .orderBy(desc(listings.createdAt))
      .$dynamic();
    if (filter?.limit !== undefined) q = q.limit(filter.limit);
    if (filter?.offset) q = q.offset(filter.offset);
    const rows = await q;
    return rows.map(toListing);
  }
  async countListings(filter?: ListingFilter): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(listings)
      .where(listingConds(filter));
    return r?.n ?? 0;
  }
  async updateListingStatus(id: string, status: ListingStatus): Promise<void> {
    await this.db
      .update(listings)
      .set({ status, updatedAt: new Date() })
      .where(eq(listings.id, id));
  }
  async updateListing(
    id: string,
    patch: Partial<Pick<Listing, "title" | "price" | "attributes">>,
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.price !== undefined) set.priceMinor = minor(patch.price);
    if (patch.attributes !== undefined) set.attributes = patch.attributes;
    await this.db.update(listings).set(set).where(eq(listings.id, id));
  }
  async countOperatorListings(operatorId: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(listings)
      .where(
        and(
          eq(listings.operatorId, operatorId),
          sql`${listings.status} <> 'archived'`,
        ),
      );
    return r?.n ?? 0;
  }

  async createRfq(r: Omit<Rfq, "id" | "createdAt" | "status" | "accessToken">): Promise<Rfq> {
    const [row] = await this.db
      .insert(rfqs)
      .values({
        vertical: r.vertical,
        listingId: r.listingId || null,
        buyerEmail: r.buyerEmail,
        fields: r.fields,
        status: "new",
      })
      .returning();
    return toRfq(row!);
  }
  async getRfq(id: string): Promise<Rfq | undefined> {
    if (!isUuid(id)) return undefined;
    const [r] = await this.db
      .select()
      .from(rfqs)
      .where(eq(rfqs.id, id))
      .limit(1);
    return r ? toRfq(r) : undefined;
  }
  async setRfqStatus(id: string, status: RfqStatus): Promise<void> {
    // iface "open" -> db "new"; iface "expired" has no db state -> "closed".
    const dbStatus =
      status === "open" ? "new" : status === "expired" ? "closed" : status;
    await this.db
      .update(rfqs)
      .set({ status: dbStatus })
      .where(eq(rfqs.id, id));
  }
  async listRfqs(filter?: {
    buyerEmail?: string;
    operatorId?: string;
    limit?: number;
    offset?: number;
  }): Promise<Rfq[]> {
    if (filter?.operatorId) {
      // Owner sees the RFQ via its listing; a fan-out-matched operator sees it
      // once the match is delivered — any state except 'delayed' counts (the
      // notification job flips pending→sent and the RFQ must stay visible).
      const matched = sql`exists (
        select 1 from rfq_matches m
        where m.rfq_id = ${rfqs.id}
          and m.operator_id = ${filter.operatorId}
          and m.state <> 'delayed'
      )`;
      let q = this.db
        .select({ rfq: rfqs })
        .from(rfqs)
        .innerJoin(listings, eq(rfqs.listingId, listings.id))
        .where(
          or(eq(listings.operatorId, filter.operatorId), matched),
        )
        .orderBy(desc(rfqs.createdAt))
        .$dynamic();
      if (filter.limit !== undefined) q = q.limit(filter.limit);
      if (filter.offset) q = q.offset(filter.offset);
      return (await q).map((r) => toRfq(r.rfq));
    }
    const conds = [];
    if (filter?.buyerEmail) conds.push(eq(rfqs.buyerEmail, filter.buyerEmail));
    let q = this.db
      .select()
      .from(rfqs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(rfqs.createdAt))
      .$dynamic();
    if (filter?.limit !== undefined) q = q.limit(filter.limit);
    if (filter?.offset) q = q.offset(filter.offset);
    return (await q).map(toRfq);
  }

  async countRfqs(filter?: {
    buyerEmail?: string;
    operatorId?: string;
    statusNot?: RfqStatus[];
  }): Promise<number> {
    // iface statuses -> db vocabulary (open -> new; expired -> closed).
    const bannedDb = filter?.statusNot?.map((s) =>
      s === "open" ? "new" : s === "expired" ? "closed" : s,
    );
    const statusCond = bannedDb?.length
      ? sql`${rfqs.status} NOT IN ${bannedDb}`
      : undefined;
    if (filter?.operatorId) {
      // Same visibility window as listRfqs: delivered = any state but delayed.
      const matched = sql`exists (
        select 1 from rfq_matches m
        where m.rfq_id = ${rfqs.id}
          and m.operator_id = ${filter.operatorId}
          and m.state <> 'delayed'
      )`;
      const conds = [or(eq(listings.operatorId, filter.operatorId), matched)!];
      if (statusCond) conds.push(statusCond);
      const [r] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(rfqs)
        .innerJoin(listings, eq(rfqs.listingId, listings.id))
        .where(and(...conds));
      return r?.n ?? 0;
    }
    const conds = [];
    if (filter?.buyerEmail) conds.push(eq(rfqs.buyerEmail, filter.buyerEmail));
    if (statusCond) conds.push(statusCond);
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(rfqs)
      .where(conds.length ? and(...conds) : undefined);
    return r?.n ?? 0;
  }

  async hasRfqMatch(rfqId: string, operatorId: string): Promise<boolean> {
    // 'delayed' is the only undelivered state — pending AND post-notification
    // (sent/failed) both grant access, else the RFQ disappears from the inbox
    // the moment its email is sent.
    const [r] = await this.db
      .select({ id: rfqMatches.id })
      .from(rfqMatches)
      .where(
        and(
          eq(rfqMatches.rfqId, rfqId),
          eq(rfqMatches.operatorId, operatorId),
          sql`${rfqMatches.state} <> 'delayed'`,
        ),
      )
      .limit(1);
    return r !== undefined;
  }

  async createRfqMatches(
    rows: {
      rfqId: string;
      operatorId: string;
      listingId?: string | null;
      deliverAt?: Date;
    }[],
  ): Promise<void> {
    if (!rows.length) return;
    const now = new Date();
    await this.db
      .insert(rfqMatches)
      .values(
        rows.map((r) => ({
          rfqId: r.rfqId,
          operatorId: r.operatorId,
          listingId: r.listingId ?? null,
          state:
            r.deliverAt && r.deliverAt > now
              ? ("delayed" as const)
              : ("pending" as const),
          deliverAt: r.deliverAt ?? now,
        })),
      )
      .onConflictDoNothing({
        target: [rfqMatches.rfqId, rfqMatches.operatorId],
      });
    // Mirror the worker's markRfqMatched — only off 'new', never resurrect.
    await this.db
      .update(rfqs)
      .set({ status: "matched" })
      .where(and(eq(rfqs.id, rows[0]!.rfqId), eq(rfqs.status, "new")));
  }

  async expireRfqs(cutoff: string) {
    return expireStaleRfqs(this.db, new Date(cutoff));
  }

  async createQuote(
    q: Omit<Quote, "id" | "createdAt" | "status">,
  ): Promise<Quote> {
    const [row] = await this.db
      .insert(quotes)
      .values({
        rfqId: q.rfqId,
        operatorId: q.operatorId,
        amountMinor: minor(q.amount),
        currency: q.currency,
        message: q.message,
        status: "sent",
      })
      .returning();
    await this.db
      .update(rfqs)
      .set({ status: "quoted" })
      .where(eq(rfqs.id, q.rfqId));
    return toQuote(row!);
  }
  async getQuote(id: string): Promise<Quote | undefined> {
    if (!isUuid(id)) return undefined;
    const [r] = await this.db
      .select()
      .from(quotes)
      .where(eq(quotes.id, id))
      .limit(1);
    return r ? toQuote(r) : undefined;
  }
  async listQuotes(filter?: {
    rfqId?: string;
    operatorId?: string;
  }): Promise<Quote[]> {
    const conds = [];
    if (filter?.rfqId) conds.push(eq(quotes.rfqId, filter.rfqId));
    if (filter?.operatorId) conds.push(eq(quotes.operatorId, filter.operatorId));
    const rows = await this.db
      .select()
      .from(quotes)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(quotes.createdAt));
    return rows.map(toQuote);
  }
  async setQuoteStatus(id: string, status: QuoteStatus): Promise<void> {
    await this.db
      .update(quotes)
      .set({ status, updatedAt: new Date() })
      .where(eq(quotes.id, id));
  }

  async createDeal(d: Omit<Deal, "id" | "closedAt">): Promise<Deal> {
    const [row] = await this.db
      .insert(deals)
      .values({
        quoteId: d.quoteId,
        closedAt: new Date(),
        feePct: d.feePct,
        feeAmountMinor: minor(d.feeAmount),
        currency: "USD",
        invoiceStatus: d.invoiceStatus,
      })
      .returning();
    const [q] = await this.db
      .select()
      .from(quotes)
      .where(eq(quotes.id, d.quoteId))
      .limit(1);
    return toDeal(row!, q!);
  }
  async getDeal(id: string): Promise<Deal | undefined> {
    if (!isUuid(id)) return undefined;
    const [r] = await this.db
      .select({ deal: deals, quote: quotes })
      .from(deals)
      .innerJoin(quotes, eq(deals.quoteId, quotes.id))
      .where(eq(deals.id, id))
      .limit(1);
    return r ? toDeal(r.deal, r.quote) : undefined;
  }
  async setDealInvoice(
    id: string,
    status: Deal["invoiceStatus"],
    ref?: string,
  ): Promise<void> {
    await this.db
      .update(deals)
      .set({
        invoiceStatus: status,
        ...(ref !== undefined ? { invoiceRef: ref } : {}),
      })
      .where(eq(deals.id, id));
  }
  async listDeals(filter?: {
    operatorId?: string;
    limit?: number;
    offset?: number;
  }): Promise<Deal[]> {
    // operatorId lives on the parent quote — join first so the filter is SQL.
    const conds = filter?.operatorId
      ? [eq(quotes.operatorId, filter.operatorId)]
      : [];
    let q = this.db
      .select({ deal: deals, quote: quotes })
      .from(deals)
      .innerJoin(quotes, eq(deals.quoteId, quotes.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(deals.closedAt))
      .$dynamic();
    if (filter?.limit !== undefined) q = q.limit(filter.limit);
    if (filter?.offset) q = q.offset(filter.offset);
    return (await q).map((r) => toDeal(r.deal, r.quote));
  }
  async countDeals(filter?: { operatorId?: string }): Promise<number> {
    const conds = filter?.operatorId
      ? [eq(quotes.operatorId, filter.operatorId)]
      : [];
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(deals)
      .innerJoin(quotes, eq(deals.quoteId, quotes.id))
      .where(conds.length ? and(...conds) : undefined);
    return r?.n ?? 0;
  }

  async upsertSubscription(
    s: Omit<Subscription, "id">,
  ): Promise<Subscription> {
    const eventStamp = s.lastEventAt ?? null;
    const values = {
      operatorId: s.operatorId,
      plan: s.plan,
      status: s.status,
      currentPeriodEnd: new Date(s.currentPeriodEnd),
      lastEventAt: eventStamp,
      updatedAt: new Date(),
    };
    const [r] = await this.db
      .insert(subscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: subscriptions.operatorId,
        set: values,
        // Stale-webhook gate: out-of-order provider events must not clobber
        // newer sub state. Stamped events only apply when newer than the
        // stored stamp; unstamped callers (mock checkout) always apply.
        setWhere: sql`excluded.last_event_at is null or excluded.last_event_at > coalesce(${subscriptions.lastEventAt}, 0)`,
      })
      .returning();
    if (r) return toSubscription(r);
    // A stale event lost the gate — return the current row as-is.
    const [current] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.operatorId, s.operatorId))
      .limit(1);
    if (!current)
      throw new Error("upsertSubscription: row vanished after stale-event skip");
    return toSubscription(current);
  }
  async getSubscription(
    operatorId: string,
  ): Promise<Subscription | undefined> {
    if (!isUuid(operatorId)) return undefined;
    const [r] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.operatorId, operatorId))
      .limit(1);
    return r ? toSubscription(r) : undefined;
  }
}

// process-wide singleton (one pg pool per dev server)
const g = globalThis as unknown as {
  __jmDb?: ReturnType<typeof createDb>;
};
function dbPair() {
  if (!g.__jmDb) g.__jmDb = createDb();
  return g.__jmDb;
}
export function getDrizzleRepo(): DrizzleRepo {
  return new DrizzleRepo(dbPair().db);
}
/** Raw postgres.js handle — for jobs-table helpers (e.g. rfq fan-out enqueue). */
export function getDbSql() {
  return dbPair().sql;
}
