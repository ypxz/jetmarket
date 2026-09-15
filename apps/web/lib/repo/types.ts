// Repository contract for the marketplace core. Mirrors spec §Data model so the
// in-memory implementation can be swapped for @jetmarket/db without touching routes.

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
  createUser(email: string, role?: UserRole): User;
  findUserByEmail(email: string): User | undefined;
  getUser(id: string): User | undefined;

  upsertOperator(o: Omit<Operator, "id" | "createdAt"> & { id?: string }): Operator;
  getOperator(id: string): Operator | undefined;
  getOperatorByUserId(userId: string): Operator | undefined;
  listOperators(): Operator[];
  setOperatorVerified(id: string, verified: boolean): void;
  setOperatorPlan(id: string, plan: Plan): void;

  createListing(
    l: Omit<Listing, "id" | "createdAt" | "status"> & { status?: ListingStatus },
  ): Listing;
  getListing(id: string): Listing | undefined;
  listListings(filter?: {
    operatorId?: string;
    status?: ListingStatus;
    type?: ListingType;
    vertical?: string;
    query?: string;
    facets?: Record<string, string>;
  }): Listing[];
  updateListingStatus(id: string, status: ListingStatus): void;
  countOperatorListings(operatorId: string): number;

  createRfq(r: Omit<Rfq, "id" | "createdAt" | "status">): Rfq;
  getRfq(id: string): Rfq | undefined;
  listRfqs(filter?: { buyerEmail?: string; operatorId?: string }): Rfq[];

  createQuote(q: Omit<Quote, "id" | "createdAt" | "status">): Quote;
  getQuote(id: string): Quote | undefined;
  listQuotes(filter?: { rfqId?: string; operatorId?: string }): Quote[];
  setQuoteStatus(id: string, status: QuoteStatus): void;

  createDeal(d: Omit<Deal, "id" | "closedAt">): Deal;
  listDeals(filter?: { operatorId?: string }): Deal[];

  upsertSubscription(s: Omit<Subscription, "id">): Subscription;
  getSubscription(operatorId: string): Subscription | undefined;
}
