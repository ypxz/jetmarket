/**
 * Core entity types — mirror spec §"Data model". Vertical-specific shape lives
 * in `attributes` / `fields` jsonb; core code never reads jet-specific keys
 * except through documented conventions (see matching.ts).
 */
import type { Currency } from "./money";

export type ListingStatus = "draft" | "active" | "paused" | "archived";
export type RfqStatus = "new" | "matched" | "quoted" | "closed" | "spam";
export type MatchState = "delayed" | "pending" | "sent" | "failed";
export type QuoteStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "declined"
  | "expired"
  | "withdrawn";
export type InvoiceStatus = "pending" | "invoiced" | "paid" | "void";
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "incomplete";

export interface Operator {
  id: string;
  userId: string;
  name: string;
  baseAirport: string | null;
  /** Free-text fleet description shown on the public profile. */
  fleetSummary: string | null;
  /** Manual admin flag — unverified operators get badge + RFQ delay. */
  verified: boolean;
  /** Subscription plan id (see plans.ts / VerticalConfig.fees). */
  plan: string;
  createdAt: Date;
}

export interface Listing {
  id: string;
  operatorId: string;
  vertical: string;
  /** e.g. charter | empty_leg | aircraft_sale — free-form per vertical. */
  type: string;
  title: string;
  /** Vertical-defined jsonb, validated against VerticalConfig.attributes. */
  attributes: Record<string, unknown>;
  priceMinor: number | null;
  currency: Currency;
  status: ListingStatus;
  photos: string[];
  createdAt: Date;
}

export interface Rfq {
  id: string;
  vertical: string;
  buyerEmail: string;
  /** Vertical-defined jsonb (route, dates, pax, budget, contact, ...). */
  fields: Record<string, unknown>;
  status: RfqStatus;
  createdAt: Date;
}

export interface RfqMatch {
  rfqId: string;
  operatorId: string;
  /** Listing that triggered the match, if a specific one did. */
  listingId: string | null;
  state: MatchState;
  /** When a delayed match becomes deliverable. */
  deliverAt: Date;
  createdAt: Date;
}

export interface Quote {
  id: string;
  rfqId: string;
  operatorId: string;
  amountMinor: number;
  currency: Currency;
  message: string | null;
  status: QuoteStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Deal {
  id: string;
  quoteId: string;
  closedAt: Date;
  feePct: number;
  feeAmountMinor: number;
  currency: Currency;
  invoiceStatus: InvoiceStatus;
  /** Provider invoice id once issued via payments adapter. */
  invoiceRef: string | null;
}

export interface Subscription {
  id: string;
  operatorId: string;
  plan: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
}

export interface Usage {
  operatorId: string;
  /** e.g. "active_listings", "rfqs_received". */
  metric: string;
  /** Accounting bucket, e.g. "2026-09" or "all". */
  period: string;
  value: number;
}
