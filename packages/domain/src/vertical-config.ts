/**
 * Local copy of the `packages/verticals` config contract (spec §"Vertical
 * config contract"). `packages/verticals` is T3 and had not merged when this
 * package was written — keep these types structurally identical so the import
 * can be switched to `@jetmarket/verticals` at merge time. Domain code must
 * never read jet-specific attribute keys beyond the documented conventions in
 * matching.ts.
 */
import type { ZodTypeAny } from "zod";
import type { Currency } from "./money";

/** One zod object schema per listing type -> validates listings.attributes jsonb. */
export interface AttributeSchema {
  listingType: string;
  schema: ZodTypeAny;
}

export interface FacetConfig {
  /** Facet key shown in the search sidebar, e.g. "category". */
  key: string;
  /** Attribute path inside listings.attributes this facet reads. */
  attribute: string;
  type: "select" | "range" | "boolean";
  label: string;
  /** For select facets; derived from data when omitted. */
  options?: string[];
}

export interface FieldSchema {
  key: string;
  label: string;
  type: "text" | "email" | "number" | "date" | "select" | "textarea";
  required?: boolean;
  options?: string[];
}

export interface Plan {
  id: string;
  name: string;
  /** Monthly price in minor units. */
  priceMinor: number;
  currency: Currency;
  /** null = unlimited. */
  maxListings: number | null;
  /** Minutes an RFQ sits before reaching this plan's operators. 0 = instant. */
  rfqDelayMinutes: number;
}

export interface SeoPageDef {
  slug: string;
  title: string;
  description?: string;
}

export interface VerticalConfig {
  slug: string;
  name: string;
  currency: Currency;
  listingTypes: string[];
  attributes: AttributeSchema[];
  facets: FacetConfig[];
  rfqFields: FieldSchema[];
  fees: {
    subscriptionPlans: Plan[];
    /** Percentage per listing type, e.g. { charter: 3, aircraft_sale: 1.5 }. */
    successFeePct: Record<string, number>;
  };
  /** i18n namespace owned by the vertical. */
  copy: Record<string, unknown>;
  seo: { landingPages: SeoPageDef[] };
}
