/**
 * Postgres-backed Repo over @jetmarket/db (Drizzle). Selected by getRepo()
 * when REPO=postgres or DATABASE_URL is set. Conventions:
 *  - money: db stores *_minor (cents); the Repo interface uses dollar amounts
 *  - timestamps: db Date -> ISO strings
 *  - rfqs.status db "new" -> interface "open"; db also has matched/spam
 *  - deals has no operatorId/amount columns — joined from the parent quote
 */
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@jetmarket/db";
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

const { users, operators, listings, rfqs, quotes, deals, subscriptions } =
  schema;

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
    closedAt: iso(d.closedAt),
  };
}

export class DrizzleRepo implements Repo {
  constructor(private db: Db) {}

  async createUser(email: string, role: UserRole = "buyer"): Promise<User> {
    const existing = await this.findUserByEmail(email);
    if (existing) return existing;
    const [r] = await this.db
      .insert(users)
      .values({ email, role })
      .returning();
    return toUser(r!);
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
    const [r] = await this.db
      .select()
      .from(operators)
      .where(eq(operators.id, id))
      .limit(1);
    return r ? toOperator(r) : undefined;
  }
  async getOperatorByUserId(userId: string): Promise<Operator | undefined> {
    const [r] = await this.db
      .select()
      .from(operators)
      .where(eq(operators.userId, userId))
      .limit(1);
    return r ? toOperator(r) : undefined;
  }
  async listOperators(): Promise<Operator[]> {
    const rows = await this.db.select().from(operators);
    return rows.map(toOperator);
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
    const [r] = await this.db
      .select()
      .from(listings)
      .where(eq(listings.id, id))
      .limit(1);
    return r ? toListing(r) : undefined;
  }
  async listListings(filter?: {
    operatorId?: string;
    status?: ListingStatus;
    type?: ListingType;
    vertical?: string;
    query?: string;
    facets?: Record<string, string>;
  }): Promise<Listing[]> {
    const conds = [];
    if (filter?.operatorId) conds.push(eq(listings.operatorId, filter.operatorId));
    if (filter?.status) conds.push(eq(listings.status, filter.status));
    if (filter?.type) conds.push(eq(listings.type, filter.type));
    if (filter?.vertical) conds.push(eq(listings.vertical, filter.vertical));
    if (filter?.query) {
      const q = `%${filter.query}%`;
      // match title or any stringified attribute value
      conds.push(
        or(
          ilike(listings.title, q),
          sql`${listings.attributes}::text ilike ${q}`,
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(listings)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(listings.createdAt));
    let out = rows.map(toListing);
    // jsonb facet equality stays app-side until the search provider lands
    if (filter?.facets) {
      for (const [k, v] of Object.entries(filter.facets)) {
        if (!v) continue;
        out = out.filter((l) => String(l.attributes[k] ?? "") === v);
      }
    }
    return out;
  }
  async updateListingStatus(id: string, status: ListingStatus): Promise<void> {
    await this.db
      .update(listings)
      .set({ status, updatedAt: new Date() })
      .where(eq(listings.id, id));
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

  async createRfq(r: Omit<Rfq, "id" | "createdAt" | "status">): Promise<Rfq> {
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
    const [r] = await this.db
      .select()
      .from(rfqs)
      .where(eq(rfqs.id, id))
      .limit(1);
    return r ? toRfq(r) : undefined;
  }
  async listRfqs(filter?: {
    buyerEmail?: string;
    operatorId?: string;
  }): Promise<Rfq[]> {
    if (filter?.operatorId) {
      const rows = await this.db
        .select({ rfq: rfqs })
        .from(rfqs)
        .innerJoin(listings, eq(rfqs.listingId, listings.id))
        .where(eq(listings.operatorId, filter.operatorId))
        .orderBy(desc(rfqs.createdAt));
      return rows.map((r) => toRfq(r.rfq));
    }
    const conds = [];
    if (filter?.buyerEmail) conds.push(eq(rfqs.buyerEmail, filter.buyerEmail));
    const rows = await this.db
      .select()
      .from(rfqs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(rfqs.createdAt));
    return rows.map(toRfq);
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
  async listDeals(filter?: { operatorId?: string }): Promise<Deal[]> {
    const rows = await this.db
      .select({ deal: deals, quote: quotes })
      .from(deals)
      .innerJoin(quotes, eq(deals.quoteId, quotes.id))
      .orderBy(desc(deals.closedAt));
    let out = rows.map((r) => toDeal(r.deal, r.quote));
    if (filter?.operatorId)
      out = out.filter((d) => d.operatorId === filter.operatorId);
    return out;
  }

  async upsertSubscription(
    s: Omit<Subscription, "id">,
  ): Promise<Subscription> {
    const values = {
      operatorId: s.operatorId,
      plan: s.plan,
      status: s.status,
      currentPeriodEnd: new Date(s.currentPeriodEnd),
      updatedAt: new Date(),
    };
    const [r] = await this.db
      .insert(subscriptions)
      .values(values)
      .onConflictDoUpdate({ target: subscriptions.operatorId, set: values })
      .returning();
    return toSubscription(r!);
  }
  async getSubscription(
    operatorId: string,
  ): Promise<Subscription | undefined> {
    const [r] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.operatorId, operatorId))
      .limit(1);
    return r ? toSubscription(r) : undefined;
  }
}

// process-wide singleton (one pg pool per dev server)
const g = globalThis as unknown as { __jmDb?: Db };
export function getDrizzleRepo(): DrizzleRepo {
  if (!g.__jmDb) g.__jmDb = createDb().db;
  return new DrizzleRepo(g.__jmDb);
}
