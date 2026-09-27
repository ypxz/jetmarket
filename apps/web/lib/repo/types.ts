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

export interface Repo {
  createUser(email: string, role?: UserRole): Promise<User>;
  findUserByEmail(email: string): Promise<User | undefined>;
  getUser(id: string): Promise<User | undefined>;

  upsertOperator(
    o: Omit<Operator, "id" | "createdAt"> & { id?: string },
  ): Promise<Operator>;
  getOperator(id: string): Promise<Operator | undefined>;
  getOperatorByUserId(userId: string): Promise<Operator | undefined>;
  listOperators(filter?: {
    limit?: number;
    offset?: number;
  }): Promise<Operator[]>;
  countOperators(): Promise<number>;
  setOperatorVerified(id: string, verified: boolean): Promise<void>;
  setOperatorPlan(id: string, plan: Plan): Promise<void>;

  createListing(
    l: Omit<Listing, "id" | "createdAt" | "status"> & { status?: ListingStatus },
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
  updateListingStatus(id: string, status: ListingStatus): Promise<void>;
  updateListing(
    id: string,
    patch: Partial<Pick<Listing, "title" | "price" | "attributes">>,
  ): Promise<void>;
  countOperatorListings(operatorId: string): Promise<number>;

  createRfq(r: Omit<Rfq, "id" | "createdAt" | "status" | "accessToken">): Promise<Rfq>;
  getRfq(id: string): Promise<Rfq | undefined>;
  setRfqStatus(id: string, status: RfqStatus): Promise<void>;
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
   * Memory mode has no matches table and always returns false.
   */
  hasRfqMatch(rfqId: string, operatorId: string): Promise<boolean>;
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
  listQuotes(filter?: { rfqId?: string; operatorId?: string }): Promise<Quote[]>;
  setQuoteStatus(id: string, status: QuoteStatus): Promise<void>;

  createDeal(d: Omit<Deal, "id" | "closedAt">): Promise<Deal>;
  getDeal(id: string): Promise<Deal | undefined>;
  listDeals(filter?: {
    operatorId?: string;
    limit?: number;
    offset?: number;
  }): Promise<Deal[]>;
  countDeals(filter?: { operatorId?: string }): Promise<number>;
  /** Omit `ref` to keep the existing invoiceRef (e.g. invoiced -> paid). */
  setDealInvoice(
    id: string,
    status: Deal["invoiceStatus"],
    ref?: string,
  ): Promise<void>;

  upsertSubscription(s: Omit<Subscription, "id">): Promise<Subscription>;
  getSubscription(operatorId: string): Promise<Subscription | undefined>;
}
