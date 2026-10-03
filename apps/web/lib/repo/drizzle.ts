/**
 * Postgres-backed Repo over @jetmarket/db (Drizzle). Selected by getRepo()
 * when REPO=postgres or DATABASE_URL is set. Conventions:
 *  - money: db stores *_minor (cents); the Repo interface uses dollar amounts
 *  - timestamps: db Date -> ISO strings
 *  - rfqs.status db "new" -> interface "open"; db also has matched/spam
 *  - deals has no operatorId/amount columns — joined from the parent quote
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { createDb, expireStaleRfqs, schema, type Db } from "@jetmarket/db";
import {
  fromMinorUnits,
  MINOR_UNIT_DIGITS,
  toMinorUnits,
} from "@jetmarket/domain";
import type {
  Deal,
  JobInfo,
  Listing,
  ListingSort,
  ListingStatus,
  ListingType,
  Operator,
  Plan,
  Quote,
  QuoteStatus,
  Repo,
  Rfq,
  RfqStatus,
  SearchAlert,
  Subscription,
  User,
  UserRole,
} from "./types";
import { PlanCapError } from "./types";

const {
  users,
  operators,
  listings,
  rfqs,
  rfqMatches,
  quotes,
  deals,
  subscriptions,
  jobs,
  magicLinksUsed,
  searchAlerts,
} = schema;

const iso = (d: Date | null | undefined): string =>
  (d ?? new Date()).toISOString();

/** Per-row minor-unit exponent for `col`, mirroring domain MINOR_UNIT_DIGITS. */
const minorDigitsExpr = (col: unknown) =>
  sql`case ${sql.join(
    Object.entries(MINOR_UNIT_DIGITS).map(
      ([c, d]) => sql`when ${col} = ${c} then ${d}`,
    ),
    sql` `,
  )} else 2 end`;

function toUser(r: typeof users.$inferSelect): User {
  return {
    id: r.id,
    email: r.email,
    role: r.role as UserRole,
    sessionVersion: r.sessionVersion,
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
    price: fromMinorUnits(r.priceMinor ?? 0, r.currency),
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
    concierge: r.concierge,
    createdAt: iso(r.createdAt),
  };
}
function toQuote(r: typeof quotes.$inferSelect): Quote {
  return {
    id: r.id,
    rfqId: r.rfqId,
    operatorId: r.operatorId,
    amount: fromMinorUnits(r.amountMinor, r.currency),
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

function toSearchAlert(r: typeof searchAlerts.$inferSelect): SearchAlert {
  return {
    id: r.id,
    vertical: r.vertical,
    email: r.email,
    params: r.params,
    token: r.token,
    status: r.status as SearchAlert["status"],
    pendingIds: r.pendingIds,
    lastAlertedAt: r.lastAlertedAt ? iso(r.lastAlertedAt) : null,
    createdAt: iso(r.createdAt),
  };
}

type DealRow = typeof deals.$inferSelect;
type QuoteRow = typeof quotes.$inferSelect;
function toDeal(d: DealRow, q: QuoteRow): Deal {
  return {
    id: d.id,
    quoteId: d.quoteId,
    operatorId: q.operatorId,
    amount: fromMinorUnits(q.amountMinor, q.currency),
    // The quote carries the authoritative currency; the deal column mirrors
    // it for ledger reads that don't join (QA-167).
    currency: q.currency,
    feePct: d.feePct,
    feeAmount: fromMinorUnits(d.feeAmountMinor, d.currency),
    invoiceStatus: d.invoiceStatus as Deal["invoiceStatus"],
    invoiceRef: d.invoiceRef ?? undefined,
    closedAt: iso(d.closedAt),
  };
}


const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Non-uuid ids can only come from non-db impls/tests — miss, don't 22P02. */
const isUuid = (v: string) => UUID_RE.test(v);

/** Local 23505 sniff — lib/api's version would make repo ↔ api a cycle. */
function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e; cur instanceof Error; cur = cur.cause) {
    if (
      cur.message.includes("duplicate key") ||
      cur.message.includes("23505") ||
      (cur as { code?: string }).code === "23505"
    )
      return true;
  }
  return false;
}

interface ListingFilter {
  ids?: string[];
  operatorId?: string;
  status?: ListingStatus;
  type?: ListingType;
  vertical?: string;
  query?: string;
  facets?: Record<string, string>;
  facetRanges?: { key: string; min?: number; max?: number }[];
  facetDateRanges?: { key: string; from?: string; to?: string }[];
  notExpiredByAttr?: { type: string; attr: string; asOf: string };
}

/** Shared WHERE builder so listListings/countListings never drift apart.
 *  Facet equality runs in SQL (`attributes ->> k = v`) — required for
 *  limit/offset to paginate the same set the filters describe. */
function listingConds(filter?: ListingFilter) {
  const conds = [];
  if (filter?.ids) {
    // Orphaned RFQs surface listingId "" (rfqs.listing_id is set null on
    // listing delete) — drop empty ids or Postgres rejects the in-list with
    // invalid uuid syntax and the whole inbox 500s (QA-154).
    const ids = filter.ids.filter(isUuid);
    if (ids.length === 0) return sql`false`;
    conds.push(inArray(listings.id, ids));
  }
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
        // listListings exposes `price` in major units; the column stores
        // minor units with a per-row exponent from the listing's currency.
        const digits = minorDigitsExpr(listings.currency);
        if (r.min !== undefined)
          conds.push(
            sql`${listings.priceMinor} >= ceil(${r.min} * pow(10, ${digits}))`,
          );
        if (r.max !== undefined)
          conds.push(
            sql`${listings.priceMinor} <= floor(${r.max} * pow(10, ${digits}))`,
          );
        continue;
      }
      const num = sql`case when ${listings.attributes} ->> ${r.key} ~ '^-?[0-9]+(\\.[0-9]+)?$' then (${listings.attributes} ->> ${r.key})::numeric end`;
      if (r.min !== undefined) conds.push(sql`${num} >= ${r.min}`);
      if (r.max !== undefined) conds.push(sql`${num} <= ${r.max}`);
    }
  }
  if (filter?.facetDateRanges) {
    for (const r of filter.facetDateRanges) {
      // `attributes->>key` is NULL for rows missing the attr — strict match,
      // same as memory (QA-215). ISO text compares chronologically.
      const v = sql`${listings.attributes} ->> ${r.key}`;
      if (r.from !== undefined) conds.push(sql`${v} >= ${r.from}`);
      if (r.to !== undefined) conds.push(sql`${v} <= ${r.to}`);
    }
  }
  if (filter?.notExpiredByAttr) {
    const { type, attr, asOf } = filter.notExpiredByAttr;
    // Keep rows of other types, rows missing the attr, and non-past dates —
    // NULL-safe: `NULL < x` would otherwise silently exclude undated legs.
    const v = sql`${listings.attributes} ->> ${attr}`;
    conds.push(
      or(
        ne(listings.type, type),
        sql`${v} is null`,
        sql`${v} >= ${asOf}`,
      )!,
    );
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
  async bumpSessionVersion(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, userId));
  }
  async setUserRole(userId: string, role: UserRole): Promise<void> {
    await this.db
      .update(users)
      .set({ role })
      .where(eq(users.id, userId));
  }
  async consumeMagicLinkSig(sig: string, expiresAt: string): Promise<boolean> {
    // Prune expired rows on write so the ledger stays bounded without a job.
    await this.db
      .delete(magicLinksUsed)
      .where(lt(magicLinksUsed.expiresAt, new Date()));
    // PK conflict = replay; ON CONFLICT DO NOTHING returns no row for it.
    const rows = await this.db
      .insert(magicLinksUsed)
      .values({ sig, expiresAt: new Date(expiresAt) })
      .onConflictDoNothing({ target: magicLinksUsed.sig })
      .returning({ sig: magicLinksUsed.sig });
    return rows.length === 1;
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
  async listUsers(ids: string[]): Promise<User[]> {
    // Same isUuid guard as the single-id lookups (QA-154): a non-uuid entry
    // would 22P02 the whole batch — miss it instead.
    const valid = ids.filter(isUuid);
    if (valid.length === 0) return [];
    const rows = await this.db
      .select()
      .from(users)
      .where(inArray(users.id, valid));
    return rows.map(toUser);
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
    // One operator profile per user — ON CONFLICT on the unique
    // operators.user_id index makes concurrent first-signups upsert instead
    // of minting duplicate profiles.
    const [r] = await this.db
      .insert(operators)
      .values(values)
      .onConflictDoUpdate({ target: operators.userId, set: values })
      .returning();
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
    ids?: string[];
  }): Promise<Operator[]> {
    let q = this.db
      .select()
      .from(operators)
      // Deterministic order: the admin API pages with limit/offset, and pg
      // heap order shifts when a row updates (e.g. verify toggle) — without
      // ORDER BY, page 2 can repeat or skip operators (QA-317).
      .orderBy(desc(operators.createdAt), operators.id)
      .$dynamic();
    if (filter?.ids) {
      const ids = filter.ids.filter(isUuid);
      if (ids.length === 0) return [];
      q = q.where(inArray(operators.id, ids));
    }
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
    opts?: { cap?: number },
  ): Promise<Listing> {
    return this.db.transaction(async (tx) => {
      if (opts?.cap !== undefined) {
        // Serialize per-operator writers — the FOR UPDATE row lock makes the
        // count+insert atomic against parallel creates/reactivations.
        await tx.execute(
          sql`select id from operators where id = ${l.operatorId} for update`,
        );
        const [c] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(listings)
          .where(
            and(
              eq(listings.operatorId, l.operatorId),
              eq(listings.vertical, l.vertical),
              sql`${listings.status} <> 'archived'`,
            ),
          );
        if ((c?.n ?? 0) >= opts.cap) throw new PlanCapError();
      }
      const [r] = await tx
        .insert(listings)
        .values({
          operatorId: l.operatorId,
          vertical: l.vertical,
          type: l.type,
          title: l.title,
          attributes: l.attributes,
          priceMinor: toMinorUnits(l.price, l.currency),
          currency: l.currency,
          status: l.status ?? "active",
          photos: l.photos,
        })
        .returning();
      return toListing(r!);
    });
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
    sort?: ListingSort;
  }): Promise<Listing[]> {
    let q = this.db
      .select()
      .from(listings)
      .where(listingConds(filter))
      .orderBy(
        // createdAt desc always trails: deterministic pagination even when
        // prices tie (QA-178).
        ...(filter?.sort === "price_asc"
          ? [asc(listings.priceMinor), desc(listings.createdAt)]
          : filter?.sort === "price_desc"
            ? [desc(listings.priceMinor), desc(listings.createdAt)]
            : [
                // Default ("newest") ordering honors the Pro plan's
                // priority-placement feature: pro operators' listings sort
                // first, then newest (QA-191). Explicit price sorts stay
                // pure — the caller asked for price order.
                sql`case when (select o.plan from ${operators} o where o.id = ${listings.operatorId}) = 'pro' then 0 else 1 end`,
                desc(listings.createdAt),
              ]),
      )
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
  async updateListingStatus(
    id: string,
    status: ListingStatus,
    opts?: { cap?: number },
  ): Promise<void> {
    if (status !== "active" || opts?.cap === undefined) {
      await this.db
        .update(listings)
        .set({ status, updatedAt: new Date() })
        .where(eq(listings.id, id));
      return;
    }
    const cap = opts.cap;
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          operatorId: listings.operatorId,
          status: listings.status,
          vertical: listings.vertical,
        })
        .from(listings)
        .where(eq(listings.id, id))
        .limit(1);
      if (!row) return;
      await tx.execute(
        sql`select id from operators where id = ${row.operatorId} for update`,
      );
      const [c] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(listings)
        .where(
          and(
            eq(listings.operatorId, row.operatorId),
            eq(listings.vertical, row.vertical),
            sql`${listings.status} <> 'archived'`,
          ),
        );
      // The listing itself already counts toward the cap unless archived —
      // reactivating its own row is not an overage, so count the others.
      const selfCounted = row.status === "archived" ? 0 : 1;
      const others = Math.max(0, (c?.n ?? 0) - selfCounted);
      if (others >= cap) throw new PlanCapError();
      await tx
        .update(listings)
        .set({ status, updatedAt: new Date() })
        .where(eq(listings.id, id));
    });
  }
  async updateListing(
    id: string,
    patch: Partial<Pick<Listing, "title" | "price" | "attributes" | "photos">>,
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.price !== undefined) {
      const [row] = await this.db
        .select({ c: listings.currency })
        .from(listings)
        .where(eq(listings.id, id))
        .limit(1);
      set.priceMinor = toMinorUnits(patch.price, row?.c ?? "USD");
    }
    if (patch.attributes !== undefined) set.attributes = patch.attributes;
    if (patch.photos !== undefined) set.photos = patch.photos;
    await this.db.update(listings).set(set).where(eq(listings.id, id));
  }
  async listListingCountsByOperator(
    operatorIds: string[],
    vertical?: string,
  ): Promise<Record<string, number>> {
    if (operatorIds.length === 0) return {};
    const rows = await this.db
      .select({
        operatorId: listings.operatorId,
        n: sql<number>`count(*)::int`,
      })
      .from(listings)
      .where(
        and(
          inArray(listings.operatorId, operatorIds.filter(isUuid)),
          sql`${listings.status} <> 'archived'`,
          ...(vertical ? [eq(listings.vertical, vertical)] : []),
        ),
      )
      .groupBy(listings.operatorId);
    return Object.fromEntries(rows.map((r) => [r.operatorId, r.n]));
  }
  async countOperatorListings(
    operatorId: string,
    vertical?: string,
  ): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(listings)
      .where(
        and(
          eq(listings.operatorId, operatorId),
          sql`${listings.status} <> 'archived'`,
          ...(vertical ? [eq(listings.vertical, vertical)] : []),
        ),
      );
    return r?.n ?? 0;
  }

  async createRfq(
    r: Omit<
      Rfq,
      "id" | "createdAt" | "status" | "accessToken" | "concierge"
    > & {
      dedupeKey?: string;
      accessToken?: string;
    },
  ): Promise<Rfq> {
    const [row] = await this.db
      .insert(rfqs)
      .values({
        vertical: r.vertical,
        listingId: r.listingId || null,
        buyerEmail: r.buyerEmail,
        fields: r.fields,
        status: "new",
        dedupeKey: r.dedupeKey ?? null,
        ...(r.accessToken ? { accessToken: r.accessToken } : {}),
      })
      .returning();
    return toRfq(row!);
  }
  async getRfqByDedupeKey(key: string): Promise<Rfq | undefined> {
    // Only a LIVE twin counts — the partial unique index guarantees at most
    // one. A resubmit over a closed/spam RFQ mints a fresh row (QA-228).
    const [r] = await this.db
      .select()
      .from(rfqs)
      .where(
        and(
          eq(rfqs.dedupeKey, key),
          inArray(rfqs.status, ["new", "matched", "quoted"]),
        ),
      )
      .limit(1);
    return r ? toRfq(r) : undefined;
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
  async setRfqStatus(
    id: string,
    status: RfqStatus,
    expectedIn: RfqStatus[],
  ): Promise<boolean> {
    // iface "open" -> db "new"; iface "expired" has no db state -> "closed".
    const toDb = (s: RfqStatus) =>
      s === "open" ? "new" : s === "expired" ? "closed" : s;
    const rows = await this.db
      .update(rfqs)
      .set({ status: toDb(status) })
      .where(
        and(eq(rfqs.id, id), inArray(rfqs.status, expectedIn.map(toDb))),
      )
      .returning({ id: rfqs.id });
    return rows.length > 0;
  }
  async expediteRfq(id: string) {
    if (!isUuid(id)) return { applied: false, matches: [] };
    return this.db.transaction(async (tx) => {
      const flipped = await tx
        .update(rfqs)
        .set({ concierge: true })
        .where(
          and(
            eq(rfqs.id, id),
            eq(rfqs.concierge, false),
            inArray(rfqs.status, ["new", "matched", "quoted"]),
          ),
        )
        .returning({ id: rfqs.id });
      if (flipped.length === 0) return { applied: false, matches: [] };
      // Every still-delayed match of this RFQ is due NOW — the concierge
      // purchase skips the free-plan delay window. Pending rows are already
      // deliverable; sent/failed ones stay untouched.
      const matches = await tx
        .update(rfqMatches)
        .set({ state: "pending", deliverAt: new Date() })
        .where(
          and(eq(rfqMatches.rfqId, id), eq(rfqMatches.state, "delayed")),
        )
        .returning({ id: rfqMatches.id, operatorId: rfqMatches.operatorId });
      return { applied: true, matches };
    });
  }

  /** Still undelivered = state 'delayed' — clock-stale rows count too: the
   *  concierge flip delivers them regardless of when the worker last ran. */
  async countRfqPendingMatches(rfqId: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(rfqMatches)
      .where(and(eq(rfqMatches.rfqId, rfqId), eq(rfqMatches.state, "delayed")));
    return r?.n ?? 0;
  }

  /** Delivered = every state except 'delayed' — the same read rule the
   *  operator inbox applies to match visibility. */
  async countDeliveredMatches(rfqIds: string[]): Promise<Record<string, number>> {
    if (!rfqIds.length) return {};
    const rows = await this.db
      .select({ rfqId: rfqMatches.rfqId, n: sql<number>`count(*)::int` })
      .from(rfqMatches)
      .where(
        and(
          inArray(rfqMatches.rfqId, rfqIds),
          ne(rfqMatches.state, "delayed"),
        ),
      )
      .groupBy(rfqMatches.rfqId);
    return Object.fromEntries(rows.map((r) => [r.rfqId, r.n]));
  }

  async listRfqs(filter?: {
    buyerEmail?: string;
    operatorId?: string;
    needsQuote?: boolean;
    vertical?: string;
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
      // leftJoin, not inner: rfqs.listing_id goes NULL on listing delete
      // (set null) — an inner join would silently drop those RFQs from the
      // matched operator's inbox, diverging from the memory impl (QA-159).
      let q = this.db
        .select({ rfq: rfqs })
        .from(rfqs)
        .leftJoin(listings, eq(rfqs.listingId, listings.id))
        .where(
          and(
            or(eq(listings.operatorId, filter.operatorId), matched),
            ...(filter.vertical
              ? [eq(rfqs.vertical, filter.vertical)]
              : []),
            ...(filter.needsQuote
              ? [
                  // "Needs a quote": no live quote from THIS operator —
                  // declined/withdrawn don't hide the RFQ (QA-402).
                  sql`not exists (
                    select 1 from quotes q
                    where q.rfq_id = ${rfqs.id}
                      and q.operator_id = ${filter.operatorId}
                      and q.status in ('sent','accepted')
                  )`,
                ]
              : []),
          ),
        )
        // Operator inbox: paid concierge expedites answer first — burying one
        // under newer unpaid RFQs defeats the $49 promise (QA-400). Other
        // surfaces (buyer/admin) keep plain newest-first.
        .orderBy(desc(rfqs.concierge), desc(rfqs.createdAt))
        .$dynamic();
      if (filter.limit !== undefined) q = q.limit(filter.limit);
      if (filter.offset) q = q.offset(filter.offset);
      return (await q).map((r) => toRfq(r.rfq));
    }
    const conds = [];
    if (filter?.buyerEmail)
      conds.push(eq(rfqs.buyerEmail, filter.buyerEmail.toLowerCase()));
    if (filter?.vertical)
      conds.push(eq(rfqs.vertical, filter.vertical));
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
    needsQuote?: boolean;
    vertical?: string;
    statusNot?: RfqStatus[];
    since?: string;
    concierge?: boolean;
  }): Promise<number> {
    // iface statuses -> db vocabulary (open -> new; expired -> closed).
    const bannedDb = filter?.statusNot?.map((s) =>
      s === "open" ? "new" : s === "expired" ? "closed" : s,
    );
    const statusCond = bannedDb?.length
      ? sql`${rfqs.status} NOT IN ${bannedDb}`
      : undefined;
    const sinceCond = filter?.since
      ? gte(rfqs.createdAt, new Date(filter.since))
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
      if (filter.vertical)
        conds.push(eq(rfqs.vertical, filter.vertical));
      if (statusCond) conds.push(statusCond);
      if (sinceCond) conds.push(sinceCond);
      if (filter.concierge) conds.push(eq(rfqs.concierge, true));
      if (filter.needsQuote)
        conds.push(
          sql`not exists (
            select 1 from quotes q
            where q.rfq_id = ${rfqs.id}
              and q.operator_id = ${filter.operatorId}
              and q.status in ('sent','accepted')
          )`,
        );
      const [r] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(rfqs)
        .leftJoin(listings, eq(rfqs.listingId, listings.id))
        .where(and(...conds));
      return r?.n ?? 0;
    }
    const conds = [];
    if (filter?.buyerEmail)
      conds.push(eq(rfqs.buyerEmail, filter.buyerEmail.toLowerCase()));
    if (filter?.vertical)
      conds.push(eq(rfqs.vertical, filter.vertical));
    if (statusCond) conds.push(statusCond);
    if (sinceCond) conds.push(sinceCond);
    if (filter?.concierge) conds.push(eq(rfqs.concierge, true));
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(rfqs)
      .where(conds.length ? and(...conds) : undefined);
    return r?.n ?? 0;
  }

  async countPendingRfqs(operatorId: string, vertical?: string): Promise<number> {
    // 'delayed' state already encodes deliverAt > now — the worker sweep
    // promotes due rows. Terminal rfqs (closed covers iface 'expired',
    // plus spam) don't count toward the teaser.
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(rfqMatches)
      .innerJoin(rfqs, eq(rfqMatches.rfqId, rfqs.id))
      .where(
        and(
          eq(rfqMatches.operatorId, operatorId),
          eq(rfqMatches.state, "delayed"),
          sql`${rfqs.status} NOT IN ('closed', 'spam')`,
          ...(vertical ? [eq(rfqs.vertical, vertical)] : []),
        ),
      );
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

  async expireRfqs(cutoff: string, vertical?: string) {
    return expireStaleRfqs(this.db, new Date(cutoff), vertical);
  }

  async createQuote(
    q: Omit<Quote, "id" | "createdAt" | "status">,
  ): Promise<Quote> {
    const [row] = await this.db
      .insert(quotes)
      .values({
        rfqId: q.rfqId,
        operatorId: q.operatorId,
        amountMinor: toMinorUnits(q.amount, q.currency),
        currency: q.currency,
        message: q.message,
        status: "sent",
      })
      .returning();
    // Only live RFQs become 'quoted' — an unconditional flip could resurrect
    // a 'closed' RFQ (accept won between the route's status check and this
    // write) and let a second deal mint (QA-165).
    await this.db
      .update(rfqs)
      .set({ status: "quoted" })
      .where(
        and(eq(rfqs.id, q.rfqId), inArray(rfqs.status, ["new", "matched", "quoted"])),
      );
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
    ids?: string[];
    rfqIds?: string[];
  }): Promise<Quote[]> {
    const conds = [];
    if (filter?.rfqId) conds.push(eq(quotes.rfqId, filter.rfqId));
    if (filter?.operatorId) conds.push(eq(quotes.operatorId, filter.operatorId));
    if (filter?.ids) {
      const ids = filter.ids.filter(isUuid);
      if (ids.length === 0) return [];
      conds.push(inArray(quotes.id, ids));
    }
    if (filter?.rfqIds) {
      const ids = filter.rfqIds.filter(isUuid);
      if (ids.length === 0) return [];
      conds.push(inArray(quotes.rfqId, ids));
    }
    const rows = await this.db
      .select()
      .from(quotes)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(quotes.createdAt));
    return rows.map(toQuote);
  }
  async countQuotes(filter?: {
    operatorId?: string;
    status?: QuoteStatus;
    since?: string;
  }): Promise<number> {
    const conds = [];
    if (filter?.operatorId) conds.push(eq(quotes.operatorId, filter.operatorId));
    if (filter?.status) conds.push(eq(quotes.status, filter.status));
    if (filter?.since)
      conds.push(gte(quotes.createdAt, new Date(filter.since)));
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(quotes)
      .where(conds.length ? and(...conds) : undefined);
    return r?.n ?? 0;
  }
  async setQuoteStatus(
    id: string,
    status: QuoteStatus,
    expected: QuoteStatus,
  ): Promise<boolean> {
    const rows = await this.db
      .update(quotes)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(quotes.id, id), eq(quotes.status, expected)))
      .returning({ id: quotes.id });
    return rows.length > 0;
  }

  async listJobs(filter?: {
    status?: JobInfo["status"];
    vertical?: string;
    limit?: number;
  }): Promise<JobInfo[]> {
    const conds = [];
    if (filter?.status) conds.push(eq(jobs.status, filter.status));
    if (filter?.vertical)
      // NULL jobs are unscoped/legacy — visible to every deploy.
      conds.push(
        or(eq(jobs.vertical, filter.vertical), isNull(jobs.vertical)),
      );
    let q = this.db
      .select()
      .from(jobs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(jobs.updatedAt))
      .$dynamic();
    q = q.limit(Math.min(filter?.limit ?? 50, 200));
    return (await q).map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      runAt: r.runAt.toISOString(),
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      lastError: r.lastError,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }
  async retryJob(id: string, vertical?: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .update(jobs)
      .set({
        status: "pending",
        runAt: new Date(),
        attempts: 0,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.status, "failed"),
          ...(vertical
            ? [or(eq(jobs.vertical, vertical), isNull(jobs.vertical))!]
            : []),
        ),
      )
      .returning({ id: jobs.id });
    return rows.length > 0;
  }

  async createDeal(d: Omit<Deal, "id" | "closedAt">): Promise<Deal> {
    const [row] = await this.db
      .insert(deals)
      .values({
        quoteId: d.quoteId,
        closedAt: new Date(),
        feePct: d.feePct,
        feeAmountMinor: toMinorUnits(d.feeAmount, d.currency),
        currency: d.currency,
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
    expectedIn?: Deal["invoiceStatus"][],
  ): Promise<boolean> {
    const rows = await this.db
      .update(deals)
      .set({
        invoiceStatus: status,
        ...(ref !== undefined ? { invoiceRef: ref } : {}),
      })
      .where(
        and(
          eq(deals.id, id),
          ...(expectedIn ? [inArray(deals.invoiceStatus, expectedIn)] : []),
        ),
      )
      .returning({ id: deals.id });
    return rows.length > 0;
  }
  async listDeals(filter?: {
    operatorId?: string;
    vertical?: string;
    limit?: number;
    offset?: number;
  }): Promise<Deal[]> {
    // operatorId lives on the parent quote, vertical on the grandparent rfq —
    // join both so the filters are SQL (QA-313).
    const conds = [
      ...(filter?.operatorId ? [eq(quotes.operatorId, filter.operatorId)] : []),
      ...(filter?.vertical ? [eq(rfqs.vertical, filter.vertical)] : []),
    ];
    let q = this.db
      .select({ deal: deals, quote: quotes })
      .from(deals)
      .innerJoin(quotes, eq(deals.quoteId, quotes.id))
      .innerJoin(rfqs, eq(quotes.rfqId, rfqs.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(deals.closedAt))
      .$dynamic();
    if (filter?.limit !== undefined) q = q.limit(filter.limit);
    if (filter?.offset) q = q.offset(filter.offset);
    return (await q).map((r) => toDeal(r.deal, r.quote));
  }
  async countDeals(filter?: {
    operatorId?: string;
    vertical?: string;
  }): Promise<number> {
    const conds = [
      ...(filter?.operatorId ? [eq(quotes.operatorId, filter.operatorId)] : []),
      ...(filter?.vertical ? [eq(rfqs.vertical, filter.vertical)] : []),
    ];
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(deals)
      .innerJoin(quotes, eq(deals.quoteId, quotes.id))
      .innerJoin(rfqs, eq(quotes.rfqId, rfqs.id))
      .where(conds.length ? and(...conds) : undefined);
    return r?.n ?? 0;
  }
  async sumDealFees(filter?: {
    operatorId?: string;
    vertical?: string;
  }): Promise<number> {
    const conds = [
      ...(filter?.operatorId ? [eq(quotes.operatorId, filter.operatorId)] : []),
      ...(filter?.vertical ? [eq(rfqs.vertical, filter.vertical)] : []),
    ];
    const digits = minorDigitsExpr(deals.currency);
    const [r] = await this.db
      .select({
        s: sql<string>`coalesce(sum(${deals.feeAmountMinor} / pow(10, ${digits})), 0)::text`,
      })
      .from(deals)
      .innerJoin(quotes, eq(deals.quoteId, quotes.id))
      .innerJoin(rfqs, eq(quotes.rfqId, rfqs.id))
      .where(conds.length ? and(...conds) : undefined);
    return Number(r?.s ?? 0);
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

  // --- saved-search alerts (QA-403) --------------------------------------

  async createSearchAlert(input: {
    vertical: string;
    email: string;
    params: Record<string, unknown>;
    token: string;
    dedupeKey: string;
  }): Promise<{ alert: SearchAlert; created: boolean }> {
    // Dedupe key decides insert vs re-subscribe: an existing row gets a
    // ROTATED token (older emailed links die), an 'off' row re-opens to
    // 'pending' (re-opt-in must re-confirm), 'active'/'pending' keep status.
    const rotate = async () => {
      const [r] = await this.db
        .update(searchAlerts)
        .set({
          token: input.token,
          email: input.email.toLowerCase(),
          params: input.params,
          status: sql`case when ${searchAlerts.status} = 'off' then 'pending' else ${searchAlerts.status} end`,
        })
        .where(eq(searchAlerts.dedupeKey, input.dedupeKey))
        .returning();
      return { alert: toSearchAlert(r!), created: false };
    };
    const [existing] = await this.db
      .select({ id: searchAlerts.id })
      .from(searchAlerts)
      .where(eq(searchAlerts.dedupeKey, input.dedupeKey))
      .limit(1);
    if (existing) return rotate();
    try {
      const [row] = await this.db
        .insert(searchAlerts)
        .values({
          vertical: input.vertical,
          email: input.email.toLowerCase(),
          params: input.params,
          token: input.token,
          dedupeKey: input.dedupeKey,
        })
        .returning();
      return { alert: toSearchAlert(row!), created: true };
    } catch (e) {
      // Concurrent first-subscribe won the unique race — rotate instead.
      if (isUniqueViolation(e)) return rotate();
      throw e;
    }
  }

  async confirmSearchAlert(token: string): Promise<SearchAlert | null> {
    const [r] = await this.db
      .update(searchAlerts)
      .set({ status: "active" })
      .where(
        and(eq(searchAlerts.token, token), eq(searchAlerts.status, "pending")),
      )
      .returning();
    return r ? toSearchAlert(r) : null;
  }

  async unsubscribeSearchAlert(token: string): Promise<boolean> {
    const r = await this.db
      .update(searchAlerts)
      .set({ status: "off" })
      .where(
        and(eq(searchAlerts.token, token), ne(searchAlerts.status, "off")),
      );
    return (r.count ?? 0) > 0;
  }

  async listSearchAlerts(filter: {
    vertical: string;
    status?: SearchAlert["status"];
    email?: string;
  }): Promise<SearchAlert[]> {
    const rows = await this.db
      .select()
      .from(searchAlerts)
      .where(
        and(
          eq(searchAlerts.vertical, filter.vertical),
          ...(filter.status ? [eq(searchAlerts.status, filter.status)] : []),
          ...(filter.email ? [eq(searchAlerts.email, filter.email)] : []),
        ),
      );
    return rows.map(toSearchAlert);
  }

  async appendSearchAlertPending(alertId: string, listingId: string) {
    if (!isUuid(alertId) || !isUuid(listingId)) return;
    // Distinct append: only add when the id isn't already queued.
    await this.db.execute(sql`
      update search_alerts
      set pending_ids = pending_ids || ${JSON.stringify([listingId])}::jsonb
      where id = ${alertId}
        and not (pending_ids @> ${JSON.stringify([listingId])}::jsonb)
    `);
  }

  async markSearchAlerted(id: string) {
    if (!isUuid(id)) return;
    await this.db
      .update(searchAlerts)
      .set({ lastAlertedAt: new Date(), pendingIds: [] })
      .where(eq(searchAlerts.id, id));
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
