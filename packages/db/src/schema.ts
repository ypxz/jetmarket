/**
 * Drizzle schema — mirrors migrations/0001_init.sql. Keep the two in sync;
 * migrations are hand-written SQL (deterministic), this file is the typed view.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  role: text("role", { enum: ["buyer", "operator", "admin"] })
    .notNull()
    .default("operator"),
  sessionVersion: integer("session_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const operators = pgTable(
  "operators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseAirport: text("base_airport"),
    fleetSummary: text("fleet_summary"),
    verified: boolean("verified").notNull().default(false),
    plan: text("plan").notNull().default("free"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("operators_user_uniq").on(t.userId)],
);

export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    vertical: text("vertical").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    attributes: jsonb("attributes")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    priceMinor: bigint("price_minor", { mode: "number" }),
    currency: text("currency").notNull().default("USD"),
    status: text("status", {
      enum: ["draft", "active", "paused", "archived"],
    })
      .notNull()
      .default("draft"),
    photos: jsonb("photos").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("listings_operator_idx").on(t.operatorId),
    index("listings_search_idx").on(t.vertical, t.status, t.type),
  ],
);

export const rfqs = pgTable(
  "rfqs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vertical: text("vertical").notNull(),
    listingId: uuid("listing_id").references(() => listings.id, {
      onDelete: "set null",
    }),
    buyerEmail: text("buyer_email").notNull(),
    accessToken: text("access_token")
      .notNull()
      .unique()
      .default(sql`gen_random_uuid()::text`),
    fields: jsonb("fields")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    dedupeKey: text("dedupe_key"),
    // Buyer concierge ($49/request): paid expedite — delayed fan-out matches
    // deliver immediately instead of after the free-plan delay.
    concierge: boolean("concierge").notNull().default(false),
    status: text("status", {
      enum: ["new", "matched", "quoted", "closed", "spam"],
    })
      .notNull()
      .default("new"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("rfqs_status_idx").on(t.status, t.createdAt),
    index("rfqs_buyer_idx").on(t.buyerEmail, t.createdAt),
    uniqueIndex("rfqs_dedupe_key")
      .on(t.dedupeKey)
      .where(
        sql`${t.dedupeKey} is not null and ${t.status} in ('new', 'matched', 'quoted')`,
      ),
  ],
);

export const rfqMatches = pgTable(
  "rfq_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rfqId: uuid("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id").references(() => listings.id, {
      onDelete: "set null",
    }),
    state: text("state", { enum: ["delayed", "pending", "sent", "failed"] })
      .notNull()
      .default("pending"),
    deliverAt: timestamp("deliver_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("rfq_matches_rfq_operator_uniq").on(t.rfqId, t.operatorId),
    index("rfq_matches_due_idx").on(t.state, t.deliverAt),
    index("rfq_matches_operator_idx").on(t.operatorId),
  ],
);

export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rfqId: uuid("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("USD"),
    message: text("message"),
    status: text("status", {
      enum: ["draft", "sent", "accepted", "declined", "expired", "withdrawn"],
    })
      .notNull()
      .default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One *live* quote per (rfq, operator) — terminal statuses don't count,
    // so decline/withdraw frees the operator to re-quote (0002 migration).
    uniqueIndex("quotes_rfq_operator_live_uniq")
      .on(t.rfqId, t.operatorId)
      .where(sql`status in ('sent', 'accepted')`),
    index("quotes_rfq_idx").on(t.rfqId),
    // Dashboard stats + operator inbox filter standalone on operator_id.
    index("quotes_operator_idx").on(t.operatorId),
  ],
);

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  quoteId: uuid("quote_id")
    .notNull()
    .unique()
    .references(() => quotes.id, { onDelete: "cascade" }),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
  feePct: numeric("fee_pct", { precision: 6, scale: 4, mode: "number" }).notNull(),
  feeAmountMinor: bigint("fee_amount_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("USD"),
  invoiceStatus: text("invoice_status", {
    enum: ["pending", "invoiced", "paid", "void"],
  })
    .notNull()
    .default("pending"),
  invoiceRef: text("invoice_ref"),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .unique()
      .references(() => operators.id, { onDelete: "cascade" }),
    plan: text("plan").notNull(),
    status: text("status", {
      enum: ["incomplete", "trialing", "active", "past_due", "canceled"],
    })
      .notNull()
      .default("incomplete"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    /** unix seconds of the last applied provider event — stale-webhook gate. */
    lastEventAt: bigint("last_event_at", { mode: "number" }),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status", {
      enum: ["pending", "running", "done", "failed"],
    })
      .notNull()
      .default("pending"),
    /** Owning vertical — NULL rows are claimable by any deploy's worker. */
    vertical: text("vertical"),
    runAt: timestamp("run_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("jobs_claim_idx").on(t.status, t.runAt)],
);

export const searchAlerts = pgTable(
  "search_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vertical: text("vertical").notNull(),
    email: text("email").notNull(),
    /** Raw /search URL params — re-applied through listingFilterFor at match
     *  time, so only whitelisted facet keys can ever filter (QA-403). */
    params: jsonb("params")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Confirm + unsubscribe bearer (emailed links only). */
    token: text("token").notNull().unique(),
    /** hash(vertical | email | canonical params) — same search re-subscribes
     *  one row with a rotated token, never a stack of duplicates. */
    dedupeKey: text("dedupe_key").notNull().unique(),
    status: text("status", { enum: ["pending", "active", "off"] })
      .notNull()
      .default("pending"),
    /** Matched listing ids queued during the per-alert mail cooldown — the
     *  next digest carries them. 'daily' rows queue EVERY match here
     *  (QA-406): they never instant-mail, the matured-backlog sweep is
     *  their only delivery path. */
    pendingIds: jsonb("pending_ids").$type<string[]>().notNull().default([]),
    freq: text("freq", { enum: ["instant", "daily"] })
      .notNull()
      .default("instant"),
    lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("search_alerts_due_idx")
      .on(t.vertical, t.status, t.lastAlertedAt)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const magicLinksUsed = pgTable("magic_links_used", {
  sig: text("sig").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type OperatorRow = typeof operators.$inferSelect;
export type ListingRow = typeof listings.$inferSelect;
export type RfqRow = typeof rfqs.$inferSelect;
export type RfqMatchRow = typeof rfqMatches.$inferSelect;
export type QuoteRow = typeof quotes.$inferSelect;
export type DealRow = typeof deals.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type SearchAlertRow = typeof searchAlerts.$inferSelect;

export type NewUser = typeof users.$inferInsert;
export type NewOperator = typeof operators.$inferInsert;
export type NewListing = typeof listings.$inferInsert;
export type NewRfq = typeof rfqs.$inferInsert;
export type NewSearchAlert = typeof searchAlerts.$inferInsert;
export type NewRfqMatch = typeof rfqMatches.$inferInsert;
export type NewQuote = typeof quotes.$inferInsert;
export type NewDeal = typeof deals.$inferInsert;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type NewJob = typeof jobs.$inferInsert;
export type NewMagicLinkUsed = typeof magicLinksUsed.$inferInsert;
