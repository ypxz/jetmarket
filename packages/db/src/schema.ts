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
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  role: text("role", { enum: ["buyer", "operator", "admin"] })
    .notNull()
    .default("operator"),
  sessionVersion: integer("session_version").notNull().default(1),
  // QA-494: sign-in locale — operator/admin-facing mail renders in it.
  locale: varchar("locale").notNull().default("en"),
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
    // QA-416: last /app/rfqs render stamp — newer arrivals badge "New".
    inboxSeenAt: timestamp("inbox_seen_at", { withTimezone: true }),
    // QA-425: cooldown stamp — the unanswered-demand digest re-mails an
    // operator at most once per cooldown while their inbox has unquoted RFQs.
    unansweredMailedAt: timestamp("unanswered_mailed_at", {
      withTimezone: true,
    }),
    // QA-427: operator away switch — false removes them from every fan-out
    // (already-delivered matches stay visible in their inbox).
    acceptingRfqs: boolean("accepting_rfqs").notNull().default(true),
    // QA-505: RFQ-match mail opt-out — inbox rows still land, only the
    // email leg is muted (visibility ≠ mail volume).
    notifyRfqMatch: boolean("notify_rfq_match").notNull().default(true),
    // QA-477: once-ever stamp — an operator whose in-vertical book is still
    // empty past the grace window gets one "create your first listing" mail.
    emptyBookMailedAt: timestamp("empty_book_mailed_at", {
      withTimezone: true,
    }),
    // QA-460: admin enforcement — hides supply from public browse, stops
    // fan-outs, blocks new listings/quotes. Stronger than verified=false.
    suspended: boolean("suspended").notNull().default(false),
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
      // 'sold' (QA-498): terminal like archived but records WHY — a closed
      // deal consumed a one-off listing. App-level enum; the column is TEXT.
      enum: ["draft", "active", "paused", "archived", "sold"],
    })
      .notNull()
      .default("draft"),
    photos: jsonb("photos").$type<string[]>().notNull().default([]),
    // Public-page view counter — soft demand signal for operators (QA-413).
    views: integer("views").notNull().default(0),
    // QA-418: worker's once-only stamp for the "your listing expired" mail.
    expiryMailedAt: timestamp("expiry_mailed_at", { withTimezone: true }),
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
    // QA-493: buyer-mail locale, stamped at create from the page locale the
    // request was filed under — route handlers can't see the intl segment.
    locale: varchar("locale").notNull().default("en"),
    // QA-422: once-only stamp — the worker's stale-quote nudge mails the
    // buyer at most once per RFQ; NULL rows are claimable.
    quoteNudgeMailedAt: timestamp("quote_nudge_mailed_at", {
      withTimezone: true,
    }),
    // QA-423: once-only stamp — the "still working on it" nudge mails the
    // buyer at most once per quote-less RFQ; NULL rows are claimable.
    noQuotesMailedAt: timestamp("no_quotes_mailed_at", {
      withTimezone: true,
    }),
    // QA-447: once-only stamp — the "closing soon" nudge mails the buyer
    // at most once per RFQ that enters its liveness window live; NULL
    // rows are claimable. An extend that pushes the horizon out does NOT
    // reset it — engaged buyers don't need a second warning.
    closingMailedAt: timestamp("closing_mailed_at", {
      withTimezone: true,
    }),
    status: text("status", {
      enum: ["new", "matched", "quoted", "closed", "spam"],
    })
      .notNull()
      .default("new"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // QA-482: bumped on every content write (amend / deadline extend /
    // status transition) — operator inbox marks a request "Updated" when
    // this passes their match's deliver_at.
    updatedAt: timestamp("updated_at", { withTimezone: true })
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
    // QA-506: stamped at the buyer's inbox GET; cleared by reviseQuote —
    // a revised quote is new content the buyer hasn't seen yet.
    buyerSeenAt: timestamp("buyer_seen_at", { withTimezone: true }),
    declineReason: text("decline_reason"),
    // QA-511: buyer counter-offer — the amount they proposed (minor
    // units) and when; reviseQuote clears both for the next round.
    counterAmountMinor: bigint("counter_amount_minor", { mode: "number" }),
    counteredAt: timestamp("countered_at", { withTimezone: true }),
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
  /** QA-450: provider's hosted pay page — the operator settles the
   *  success fee through it (stripe hosted_invoice_url; mock pay page). */
  invoiceUrl: text("invoice_url"),
  /** QA-451: the buyer's 1-5 rating — written once via rateDeal CAS. */
  buyerRating: integer("buyer_rating"),
  buyerRatedAt: timestamp("buyer_rated_at", { withTimezone: true }),
  /** QA-456: unrated-deal nudge stamp — doubles as the once-ever claim. */
  ratingMailedAt: timestamp("rating_mailed_at", { withTimezone: true }),
  /** QA-429 overdue-invoice reminder stamp — doubles as the 7d cooldown. */
  invoiceRemindedAt: timestamp("invoice_reminded_at", { withTimezone: true }),
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
    // QA-493: digest/confirm mail locale, stamped at subscribe.
    locale: varchar("locale").notNull().default("en"),
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

// Per-operator inbox triage (QA-420): a dismissed RFQ leaves the operator's
// listRfqs/countPendingRfqs views but stays visible to every other operator
// and to the buyer/admin — it is inbox state, not RFQ state.
export const rfqDismissals = pgTable(
  "rfq_dismissals",
  {
    rfqId: uuid("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rfqId, t.operatorId] })],
);

export const blockedEmails = pgTable(
  "blocked_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    reason: text("reason"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("blocked_emails_email_uniq").on(sql`lower(${t.email})`),
  ],
);

export const listingReports = pgTable(
  "listing_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    note: text("note"),
    status: text("status", { enum: ["open", "dismissed"] })
      .notNull()
      .default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    // One open flag per reporter per listing (QA-461).
    uniqueIndex("listing_reports_open_dedupe")
      .on(t.listingId, t.reporterId)
      .where(sql`status = 'open'`),
    index("listing_reports_status_idx").on(t.status, t.createdAt),
  ],
);

export const rfqReports = pgTable(
  "rfq_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rfqId: uuid("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One flag per operator per RFQ (QA-469).
    uniqueIndex("rfq_reports_dedupe").on(t.rfqId, t.reporterId),
  ],
);

export const adminEvents = pgTable(
  "admin_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminId: uuid("admin_id").references(() => users.id, {
      onDelete: "set null",
    }),
    event: text("event").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    meta: jsonb("meta"),
    vertical: text("vertical").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("admin_events_feed_idx").on(t.vertical, t.createdAt)],
);

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
