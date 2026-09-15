import { z } from "zod";
import type { ListingTypeSlug, VerticalConfig } from "./types";

/**
 * Compose the zod object validating `listings.attributes` for one listing type.
 * Unknown keys are stripped so config-declared attributes are the only contract.
 */
export function getAttributesSchema(
  config: VerticalConfig,
  listingType: ListingTypeSlug,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const attr of config.attributes) {
    if (attr.appliesTo.includes(listingType)) shape[attr.key] = attr.schema;
  }
  return z.object(shape);
}

/**
 * Compose the zod object validating a buyer RFQ payload (`rfqs.fields` jsonb).
 * Optional fields accept "" from HTML forms as "absent".
 */
export function buildRfqSchema(
  config: VerticalConfig,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of config.rfqFields) {
    shape[field.key] = field.required
      ? field.schema
      : z.preprocess(
          (v) => (v === "" || v === undefined ? undefined : v),
          field.schema.optional(),
        );
  }
  return z.object(shape).strip();
}
