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

export type RfqStatus = "open" | "quoted" | "closed" | "expired";

export interface Rfq {
  id: string;
  vertical: string;
  listingId: string;
  buyerEmail: string;
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
  invoiceStatus: "pending" | "invoiced" | "paid";
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
  listOperators(): Promise<Operator[]>;
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
  }): Promise<Listing[]>;
  updateListingStatus(id: string, status: ListingStatus): Promise<void>;
  countOperatorListings(operatorId: string): Promise<number>;

  createRfq(r: Omit<Rfq, "id" | "createdAt" | "status">): Promise<Rfq>;
  getRfq(id: string): Promise<Rfq | undefined>;
  setRfqStatus(id: string, status: RfqStatus): Promise<void>;
  listRfqs(filter?: {
    buyerEmail?: string;
    operatorId?: string;
  }): Promise<Rfq[]>;
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
  listDeals(filter?: { operatorId?: string }): Promise<Deal[]>;
  /** Omit `ref` to keep the existing invoiceRef (e.g. invoiced -> paid). */
  setDealInvoice(
    id: string,
    status: Deal["invoiceStatus"],
    ref?: string,
  ): Promise<void>;

  upsertSubscription(s: Omit<Subscription, "id">): Promise<Subscription>;
  getSubscription(operatorId: string): Promise<Subscription | undefined>;
}
