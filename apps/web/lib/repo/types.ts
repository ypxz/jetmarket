// Repository contract for the marketplace core. Mirrors spec §Data model so
// implementations (in-memory, Drizzle/Postgres) stay swappable per process.
// All methods are async — sync impls resolve immediately.

// Listing type is a slug from the active VerticalConfig.listingTypes —
// jets: charter|empty_leg|aircraft_sale, machinery: for_sale|for_rent|auction.
export type ListingType = string;
export type ListingStatus = "draft" | "active" | "paused" | "archived";
export type ListingSort = "newest" | "price_asc" | "price_desc";
export type UserRole = "buyer" | "operator" | "admin";
export type Plan = "free" | "pro";

export interface User {
  id: string;
  email: string;
  role: UserRole;
  /** Session cookies embed this; bumping revokes all sessions server-side. */
  sessionVersion: number;
  createdAt: string;
}

export interface Operator {
  id: string;
  userId: string;
  name: string;
  baseAirport: string;
  fleetSummary: string;
  verified: boolean;
  plan: Plan;
  createdAt: string;
}

/** Fields safe to expose on public/buyer-facing payloads — userId and plan
 * are internal (auth linkage, billing tier) and never leave the server. */
export interface PublicOperator {
  name: string;
  baseAirport: string;
  fleetSummary: string;
  verified: boolean;
}

export function publicOperator(o: Operator): PublicOperator {
  return {
    name: o.name,
    baseAirport: o.baseAirport,
    fleetSummary: o.fleetSummary,
    verified: o.verified,
  };
}

export interface Listing {
  id: string;
  operatorId: string;
  vertical: string;
  type: ListingType;
  title: string;
  attributes: Record<string, unknown>;
  price: number;
  currency: string;
  status: ListingStatus;
  photos: string[];
  createdAt: string;
}

// "matched"/"spam" are db-side states that surface through iface reads.
export type RfqStatus =
  | "open"
  | "matched"
  | "quoted"
  | "closed"
  | "expired"
  | "spam";

export interface Rfq {
  id: string;
  vertical: string;
  listingId: string;
  buyerEmail: string;
  /** Bearer token in the buyer's email link — gates quote view/accept/decline. */
  accessToken: string;
  fields: Record<string, unknown>;
  /** Buyer concierge ($49/request): paid expedite — delayed fan-out matches
   *  deliver immediately instead of after the free-plan delay. */
  concierge: boolean;
  status: RfqStatus;
  createdAt: string;
}

export type QuoteStatus = "sent" | "accepted" | "declined" | "withdrawn";

/** Read projection of a background-job row (worker queue) for admin ops. */
export interface JobInfo {
  id: string;
  kind: string;
  status: "pending" | "running" | "done" | "failed";
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  updatedAt: string;
}

export interface Quote {
  id: string;
  rfqId: string;
  operatorId: string;
  amount: number;
  currency: string;
  message: string;
  status: QuoteStatus;
  createdAt: string;
}

export interface Deal {
  id: string;
  quoteId: string;
  operatorId: string;
  amount: number;
  /** Quote's currency — machinery runs EUR; never hardcode a display one. */
  currency: string;
  feePct: number;
  feeAmount: number;
  invoiceStatus: "pending" | "invoiced" | "paid" | "void";
  /** Provider-side invoice id (stripe-mock `in_…` or mock `inv_…`). */
  invoiceRef?: string;
  closedAt: string;
}

export interface Subscription {
  id: string;
  operatorId: string;
  plan: Plan;
  status: "active" | "canceled" | "past_due";
  currentPeriodEnd: string;
  /** Provider event stamp (unix s); unstamped writes always apply. */
  lastEventAt?: number;
}

/** Thrown when a write would exceed the caller's listing cap. */
export class PlanCapError extends Error {
  constructor() {
    super("free plan listing cap reached");
    this.name = "PlanCapError";
  }
}

export interface Repo {
  createUser(email: string, role?: UserRole): Promise<User>;
  findUserByEmail(email: string): Promise<User | undefined>;
  getUser(id: string): Promise<User | undefined>;
  /** Batch-lookup users by id — join-style admin pages. */
  listUsers(ids: string[]): Promise<User[]>;
  /** Invalidate every outstanding session for the user (logout). */
  bumpSessionVersion(userId: string): Promise<void>;
  /** ADMIN_EMAILS sync on login — promote listed users, revoke removed ones. */
  setUserRole(userId: string, role: UserRole): Promise<void>;
  /**
   * Magic-link single-use ledger (QA-250): atomically records a consumed
   * signature, returning false when it was already used. Repo-backed (not
   * process memory) so a restart can't re-arm a link and a multi-instance
   * deploy keeps one-shot semantics.
   */
  consumeMagicLinkSig(sig: string, expiresAt: string): Promise<boolean>;

  upsertOperator(
    o: Omit<Operator, "id" | "createdAt"> & { id?: string },
  ): Promise<Operator>;
  getOperator(id: string): Promise<Operator | undefined>;
  getOperatorByUserId(userId: string): Promise<Operator | undefined>;
  listOperators(filter?: {
    limit?: number;
    offset?: number;
    ids?: string[];
  }): Promise<Operator[]>;
  countOperators(): Promise<number>;
  setOperatorVerified(id: string, verified: boolean): Promise<void>;
  setOperatorPlan(id: string, plan: Plan): Promise<void>;

  createListing(
    l: Omit<Listing, "id" | "createdAt" | "status"> & { status?: ListingStatus },
    /** Atomic non-archived-listing cap — throws PlanCapError instead of
     *  inserting when the operator is already at the cap. */
    opts?: { cap?: number },
  ): Promise<Listing>;
  getListing(id: string): Promise<Listing | undefined>;
  listListings(filter?: {
    operatorId?: string;
    status?: ListingStatus;
    type?: ListingType;
    vertical?: string;
    query?: string;
    facets?: Record<string, string>;
    /**
     * Numeric ranges on attribute keys (or the built-in `price`): a row
     * matches when its value is numeric and inside every bound. Missing or
     * non-numeric values never match.
     */
    facetRanges?: { key: string; min?: number; max?: number }[];
    /**
     * ISO (YYYY-MM-DD) date ranges on attribute keys — string compare works
     * because ISO dates sort lexicographically. Strict: a listing without the
     * attribute never matches a set bound (QA-215).
     */
    facetDateRanges?: { key: string; from?: string; to?: string }[];
    /**
     * Dated-inventory expiry (vertical.expiry): exclude rows where
     * `type` matches AND `attributes[attr]` is a string strictly before
     * `asOf` (ISO date). Missing attr keeps the row (QA-219).
     */
    notExpiredByAttr?: { type: string; attr: string; asOf: string };
    /** Fetch these listing ids directly — batch-lookup for join-style pages. */
    ids?: string[];
    /** Result order — `newest` (createdAt desc) is the default. */
    sort?: ListingSort;
    /** Page slice applied after all other filters. */
    limit?: number;
    offset?: number;
  }): Promise<Listing[]>;
  /** Rows matching the same filter shape, ignoring limit/offset. */
  countListings(filter?: {
    operatorId?: string;
    status?: ListingStatus;
    type?: ListingType;
    vertical?: string;
    query?: string;
    facets?: Record<string, string>;
    facetRanges?: { key: string; min?: number; max?: number }[];
    facetDateRanges?: { key: string; from?: string; to?: string }[];
    notExpiredByAttr?: { type: string; attr: string; asOf: string };
  }): Promise<number>;
  updateListingStatus(
    id: string,
    status: ListingStatus,
    /** Same atomic cap for reactivation — throws PlanCapError when the
     *  transition would put the operator over the limit. */
    opts?: { cap?: number },
  ): Promise<void>;
  updateListing(
    id: string,
    patch: Partial<Pick<Listing, "title" | "price" | "attributes" | "photos">>,
  ): Promise<void>;
  /** Non-archived count used for the plan cap + dashboard header. `vertical`
   *  scopes it on multi-vertical shared DBs — the per-plan cap is
   *  per-deploy, so foreign-vertical rows must not consume it (QA-302). */
  countOperatorListings(
    operatorId: string,
    vertical?: string,
  ): Promise<number>;
  /** Non-archived listing counts keyed by operator id — one grouped query for
   *  admin tables that would otherwise N+1 per row. `vertical` scopes to the
   *  deploy's rows on shared DBs (QA-302). */
  listListingCountsByOperator(
    operatorIds: string[],
    vertical?: string,
  ): Promise<Record<string, number>>;

  createRfq(
    r: Omit<
      Rfq,
      "id" | "createdAt" | "status" | "accessToken" | "concierge"
    > & {
      /** sha256 natural key — collides only with a LIVE twin (open/matched/
       * quoted); inserting over a terminal RFQ mints a fresh row (QA-228). */
      dedupeKey?: string;
      /** Override the random bearer token — seeds use a known token so the
       * demo buyer-inbox link is stable (QA-237). */
      accessToken?: string;
    },
  ): Promise<Rfq>;
  getRfq(id: string): Promise<Rfq | undefined>;
  /** Lookup by dedupe key — the idempotent path after a duplicate insert.
   * Returns only the live twin; terminal RFQs don't count (QA-228). */
  getRfqByDedupeKey(key: string): Promise<Rfq | undefined>;
  /** Atomically transition an RFQ to `status` when its current status is in
   * `expectedIn`; returns false otherwise. Lets accept() use the RFQ as the
   * single-winner arbiter against concurrent sibling accepts (QA-99). */
  setRfqStatus(
    id: string,
    status: RfqStatus,
    expectedIn: RfqStatus[],
  ): Promise<boolean>;
  /**
   * Matches of this RFQ still awaiting delivery — the thing a concierge
   * purchase actually buys. pg counts `state='delayed'` (a row whose
   * deliverAt passed but the worker hasn't flipped yet still counts — the
   * concierge flip delivers it too); memory counts `deliverAt > now`.
   */
  countRfqPendingMatches(rfqId: string): Promise<number>;
  /**
   * Delivered-match counts per RFQ (the inverse side of
   * `countRfqPendingMatches`): pg counts every state besides 'delayed' —
   * pending rows ARE delivered, the notify job only flips them to 'sent';
   * memory counts `!deliverAt || deliverAt <= now`, the same visibility
   * rule `matchVisible` uses. Batch shape: one call covers a whole buyer
   * inbox page without an N+1 (QA-401 — the inbox tells the buyer how many
   * operators actually received the request).
   */
  countDeliveredMatches(rfqIds: string[]): Promise<Record<string, number>>;
  /** Buyer concierge purchase: atomically set `concierge` on a LIVE RFQ and
   *  flip its still-delayed matches to deliverable (pg: state pending at
   *  deliver_at now; memory: deliverAt now). Returns `applied: false` when
   *  the RFQ is terminal/already concierge — the paid flag is set once and
   *  never unset, and only live RFQs can be expedited (a closed/expired one
   *  must not take money for a dead request). The flipped match rows carry
   *  operatorId so callers can notify (pg: worker jobs; memory: inline). */
  expediteRfq(
    id: string,
  ): Promise<{ applied: boolean; matches: { id: string; operatorId: string }[] }>;
  listRfqs(filter?: {
    buyerEmail?: string;
    /** Listing owner OR an operator with a delivered (pending) rfq_match. */
    operatorId?: string;
    /** Scope to one vertical — required on multi-vertical shared DBs (QA-293). */
    vertical?: string;
    /** Page slice applied after other filters, newest-first. */
    limit?: number;
    offset?: number;
  }): Promise<Rfq[]>;
  /**
   * True when a delivered rfq_match links this operator to the RFQ — the
   * bearer alternative to owning the RFQ's listing (QA-65: fan-out matches
   * are only usable if the matched operator can see and quote the RFQ).
   */
  hasRfqMatch(rfqId: string, operatorId: string): Promise<boolean>;
  /**
   * Record operator matches for an RFQ. Postgres mode writes rfq_matches via
   * the worker; memory mode calls this inline so mock demos exercise the
   * multi-operator loop. A row with a future `deliverAt` is invisible until
   * due (mirrors state 'delayed'); absent `deliverAt` means delivered now.
   */
  createRfqMatches(
    rows: {
      rfqId: string;
      operatorId: string;
      listingId?: string | null;
      deliverAt?: Date;
    }[],
  ): Promise<void>;
  /** RFQ rows matching the same filter shape, ignoring limit/offset. */
  countRfqs(filter?: {
    buyerEmail?: string;
    operatorId?: string;
    /** Scope to one vertical — matches listRfqs (QA-293). */
    vertical?: string;
    /** Exclude these iface statuses (e.g. "closed" counts only live RFQs). */
    statusNot?: RfqStatus[];
    /** ISO timestamp — only rows created at/after this instant count. */
    since?: string;
    /** Only count concierge-expedited RFQs (admin revenue stat). */
    concierge?: boolean;
  }): Promise<number>;
  /**
   * Delayed fan-out matches not yet due for this operator — RFQs a free-plan
   * operator can't see yet (the Pro "quote first" delay). Feeds inbox upsell
   * copy; terminal RFQs (closed/expired/spam) don't count.
   */
  /** `vertical` scopes the count on a shared DB — a jets teaser must not
   *  include machinery's delayed matches (QA-306). */
  countPendingRfqs(operatorId: string, vertical?: string): Promise<number>;
  /**
   * Expiry sweep: open/quoted rfqs whose `fields.dateTo` (YYYY-MM-DD) is
   * strictly before `cutoff` -> "expired"; their still-"sent" quotes ->
   * "declined". Returns affected counts. `vertical` scopes the sweep on
   * shared-DB deployments (QA-295).
   */
  expireRfqs(
    cutoff: string,
    vertical?: string,
  ): Promise<{ rfqs: number; quotes: number }>;

  createQuote(
    q: Omit<Quote, "id" | "createdAt" | "status">,
  ): Promise<Quote>;
  getQuote(id: string): Promise<Quote | undefined>;
  listQuotes(filter?: {
    rfqId?: string;
    operatorId?: string;
    ids?: string[];
    /** Batch-lookup: quotes belonging to any of these RFQs. */
    rfqIds?: string[];
  }): Promise<Quote[]>;
  /** Quote count for operator stats — avoids an unbounded listQuotes fetch
   *  on the dashboard (QA-151). */
  countQuotes(filter?: {
    operatorId?: string;
    status?: QuoteStatus;
    /** ISO timestamp — only rows created at/after this instant count. */
    since?: string;
  }): Promise<number>;
  /** Atomically transition a quote `expected → status`; returns false (no
   * write) when the current status is not `expected`. Required so concurrent
   * accept/decline/withdraw can't double-mutate (QA-99). */
  setQuoteStatus(
    id: string,
    status: QuoteStatus,
    expected: QuoteStatus,
  ): Promise<boolean>;

  /** Job-queue visibility for /admin/jobs (QA-102). Memory mode runs its
   *  fan-out inline — it has no queue, so these are always empty/no-ops. */
  listJobs(filter?: {
    status?: JobInfo["status"];
    /** Owning vertical — shared-DB queues are per-deploy (QA-296). */
    vertical?: string;
    limit?: number;
  }): Promise<JobInfo[]>;
  /** CAS a failed job back to pending (attempts/lastError reset); false unless
   *  the job exists and is currently failed. `vertical` additionally refuses
   *  jobs owned by another vertical (QA-296). */
  retryJob(id: string, vertical?: string): Promise<boolean>;

  createDeal(d: Omit<Deal, "id" | "closedAt">): Promise<Deal>;
  getDeal(id: string): Promise<Deal | undefined>;
  /** `vertical` scopes through deal → quote → rfq (deals carry no vertical
   * column) — admin lists/aggregates must pass it on a shared DB so
   * foreign-vertical deals don't leak into this deploy's ledger (QA-313). */
  listDeals(filter?: {
    operatorId?: string;
    vertical?: string;
    limit?: number;
    offset?: number;
  }): Promise<Deal[]>;
  countDeals(filter?: { operatorId?: string; vertical?: string }): Promise<number>;
  /** All-deals fee aggregate in major units — page-scoped reduces lie once
   * the ledger paginates (QA-171). `vertical` scopes as on listDeals. */
  sumDealFees(filter?: {
    operatorId?: string;
    vertical?: string;
  }): Promise<number>;
  /** Omit `ref` to keep the existing invoiceRef (e.g. invoiced -> paid).
   * `expectedIn` makes the write conditional on the current invoiceStatus —
   * returns false when the deal is already past it (admin void vs provider
   * settle race, QA-145). */
  setDealInvoice(
    id: string,
    status: Deal["invoiceStatus"],
    ref?: string,
    expectedIn?: Deal["invoiceStatus"][],
  ): Promise<boolean>;

  upsertSubscription(s: Omit<Subscription, "id">): Promise<Subscription>;
  getSubscription(operatorId: string): Promise<Subscription | undefined>;
}
