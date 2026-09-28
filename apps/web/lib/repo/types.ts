// Repository contract for the marketplace core. Mirrors spec §Data model so
// implementations (in-memory, Drizzle/Postgres) stay swappable per process.
// All methods are async — sync impls resolve immediately.

// Listing type is a slug from the active VerticalConfig.listingTypes —
// jets: charter|empty_leg|aircraft_sale, machinery: for_sale|for_rent|auction.
export type ListingType = string;
export type ListingStatus = "draft" | "active" | "paused" | "archived";
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
    /** Fetch these listing ids directly — batch-lookup for join-style pages. */
    ids?: string[];
    /** Page slice applied after all other filters, newest-first. */
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
  countOperatorListings(operatorId: string): Promise<number>;
  /** Non-archived listing counts keyed by operator id — one grouped query for
   *  admin tables that would otherwise N+1 per row. */
  listListingCountsByOperator(
    operatorIds: string[],
  ): Promise<Record<string, number>>;

  createRfq(
    r: Omit<Rfq, "id" | "createdAt" | "status" | "accessToken"> & {
      /** sha256 natural key — unique column; duplicate insert must throw. */
      dedupeKey?: string;
    },
  ): Promise<Rfq>;
  getRfq(id: string): Promise<Rfq | undefined>;
  /** Lookup by dedupe key — the idempotent path after a duplicate insert. */
  getRfqByDedupeKey(key: string): Promise<Rfq | undefined>;
  /** Atomically transition an RFQ to `status` when its current status is in
   * `expectedIn`; returns false otherwise. Lets accept() use the RFQ as the
   * single-winner arbiter against concurrent sibling accepts (QA-99). */
  setRfqStatus(
    id: string,
    status: RfqStatus,
    expectedIn: RfqStatus[],
  ): Promise<boolean>;
  listRfqs(filter?: {
    buyerEmail?: string;
    /** Listing owner OR an operator with a delivered (pending) rfq_match. */
    operatorId?: string;
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
    /** Exclude these iface statuses (e.g. "closed" counts only live RFQs). */
    statusNot?: RfqStatus[];
  }): Promise<number>;
  /**
   * Expiry sweep: open/quoted rfqs whose `fields.dateTo` (YYYY-MM-DD) is
   * strictly before `cutoff` -> "expired"; their still-"sent" quotes ->
   * "declined". Returns affected counts.
   */
  expireRfqs(cutoff: string): Promise<{ rfqs: number; quotes: number }>;

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
    limit?: number;
  }): Promise<JobInfo[]>;
  /** CAS a failed job back to pending (attempts/lastError reset); false unless
   *  the job exists and is currently failed. */
  retryJob(id: string): Promise<boolean>;

  createDeal(d: Omit<Deal, "id" | "closedAt">): Promise<Deal>;
  getDeal(id: string): Promise<Deal | undefined>;
  listDeals(filter?: {
    operatorId?: string;
    limit?: number;
    offset?: number;
  }): Promise<Deal[]>;
  countDeals(filter?: { operatorId?: string }): Promise<number>;
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
