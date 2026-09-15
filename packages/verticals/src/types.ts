import type { z } from "zod";

/**
 * VerticalConfig — the contract every marketplace vertical implements.
 * Core code (apps/web, domain, db) must never reference vertical-specific
 * fields directly; it reads this config. See buildApps/specs/jetmarket.md.
 */

export type VerticalSlug = "jets" | "machinery";
export type Currency = "USD" | "EUR";
export type ListingTypeSlug = string;

/** A kind of listing the vertical supports (e.g. charter, empty_leg, aircraft_sale). */
export interface ListingType {
  slug: ListingTypeSlug;
  /** i18n key inside the vertical's copy namespace. */
  labelKey: string;
  descriptionKey?: string;
}

/**
 * One validated field inside `listings.attributes` jsonb.
 * `schema` validates the stored value; `appliesTo` scopes it to listing types.
 */
export interface AttributeSchema {
  key: string;
  /** i18n key inside the vertical's copy namespace (e.g. "attributes.seats"). */
  labelKey: string;
  appliesTo: ListingTypeSlug[];
  schema: z.ZodTypeAny;
  /** Optional unit label key for display (e.g. "units.seats", "units.nm"). */
  unitKey?: string;
}

export interface FacetOption {
  value: string;
  labelKey: string;
}

/** A filter shown in the search sidebar. */
export interface FacetConfig {
  key: string;
  labelKey: string;
  type: "enum" | "number-range" | "text";
  /** Attribute jsonb key this facet filters on. Omit for built-ins (listingType). */
  attributeKey?: string;
  options?: FacetOption[];
}

/** One field of the buyer RFQ form. */
export interface FieldSchema {
  key: string;
  labelKey: string;
  type: "text" | "email" | "tel" | "number" | "date" | "select" | "textarea";
  required: boolean;
  schema: z.ZodTypeAny;
  options?: FacetOption[];
  /** Optional grouping so related fields render together (e.g. "route", "contact"). */
  groupKey?: string;
  placeholderKey?: string;
}

export interface Plan {
  slug: string;
  nameKey: string;
  monthlyPriceUsd: number;
  /** null = unlimited listings. */
  maxListings: number | null;
  /** i18n key resolving to an array of feature strings (via t.raw). */
  featuresKey: string;
  /** Hours non-paying operators wait before their RFQs arrive (spec guardrail). */
  rfqDelayHours?: number;
}

export interface FeesConfig {
  subscriptionPlans: Plan[];
  /** Success fee percent charged when a deal closes, per listing type slug. */
  successFeePct: Record<ListingTypeSlug, number>;
}

export interface SeoPageDef {
  /** URL path segment under the SEO route group (T12), e.g. "empty-legs-zurich-nice". */
  slug: string;
  titleKey: string;
  introKey?: string;
  /** Facet-keyed search filters this landing page pre-applies. */
  filters: Record<string, string>;
}

/**
 * Optional per-vertical component overrides. Typed loosely so this package
 * stays React-free; apps/web narrows the type when rendering.
 */
export interface ComponentOverrides {
  ListingCard?: unknown;
}

export interface VerticalConfig {
  slug: VerticalSlug;
  name: string;
  currency: Currency;
  listingTypes: ListingType[];
  /** Zod-validated attribute schemas per listing type -> listings.attributes jsonb. */
  attributes: AttributeSchema[];
  facets: FacetConfig[];
  rfqFields: FieldSchema[];
  fees: FeesConfig;
  /** i18n namespace holding all vertical copy (e.g. "vertical.jets"). */
  copy: { namespace: string };
  seo: { landingPages: SeoPageDef[] };
  components?: ComponentOverrides;
}
