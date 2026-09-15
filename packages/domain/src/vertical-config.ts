/**
 * VerticalConfig contract lives in `@jetmarket/verticals` (T3). Re-exported
 * here so domain consumers can keep importing from "@jetmarket/domain".
 */
export type {
  AttributeSchema,
  ComponentOverrides,
  Currency as VerticalCurrency,
  FacetConfig,
  FacetOption,
  FeesConfig,
  FieldSchema,
  ListingType,
  ListingTypeSlug,
  Plan,
  SeoPageDef,
  VerticalConfig,
  VerticalSlug,
} from "@jetmarket/verticals";
export { buildRfqSchema, getAttributesSchema } from "@jetmarket/verticals";
