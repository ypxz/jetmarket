/**
 * Drizzle schema — mirrors migrations/0001_init.sql. Keep the two in sync;
 * migrations are hand-written SQL (deterministic), this file is the typed view.
 */
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
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
  (t) => [index("operators_user_idx").on(t.userId)],
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
    fields: jsonb("fields")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status", {
      enum: ["new", "matched", "quoted", "closed", "spam"],
    })
      .notNull()
      .default("new"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("rfqs_status_idx").on(t.status, t.createdAt)],
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
    uniqueIndex("quotes_rfq_operator_uniq").on(t.rfqId, t.operatorId),
    index("quotes_rfq_idx").on(t.rfqId),
  ],
);

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  quoteId: uuid("quote_id")
    .notNull()
    .unique()
    .references(() => quotes.id, { onDelete: "cascade" }),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
  feePct: numeric("fee_pct", { precision: 5, scale: 2, mode: "number" }).notNull(),
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

export const usage = pgTable(
  "usage",
  {
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    period: text("period").notNull().default("all"),
    value: integer("value").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.operatorId, t.metric, t.period] })],
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

export type UserRow = typeof users.$inferSelect;
export type OperatorRow = typeof operators.$inferSelect;
export type ListingRow = typeof listings.$inferSelect;
export type RfqRow = typeof rfqs.$inferSelect;
export type RfqMatchRow = typeof rfqMatches.$inferSelect;
export type QuoteRow = typeof quotes.$inferSelect;
export type DealRow = typeof deals.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type UsageRow = typeof usage.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;

export type NewUser = typeof users.$inferInsert;
export type NewOperator = typeof operators.$inferInsert;
export type NewListing = typeof listings.$inferInsert;
export type NewRfq = typeof rfqs.$inferInsert;
export type NewRfqMatch = typeof rfqMatches.$inferInsert;
export type NewQuote = typeof quotes.$inferInsert;
export type NewDeal = typeof deals.$inferInsert;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type NewUsage = typeof usage.$inferInsert;
export type NewJob = typeof jobs.$inferInsert;
