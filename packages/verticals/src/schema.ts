import { z } from "zod";
import type { FieldSchema, ListingTypeSlug, VerticalConfig } from "./types";

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

/** RFQ fields rendered for a given listing type — fields without
 *  `appliesTo` show everywhere (QA-147). */
export function rfqFieldsFor(
  config: VerticalConfig,
  listingType?: string,
): FieldSchema[] {
  if (!listingType) return config.rfqFields;
  return config.rfqFields.filter(
    (f) => !f.appliesTo || f.appliesTo.includes(listingType),
  );
}

/**
 * Compose the zod object validating a buyer RFQ payload (`rfqs.fields` jsonb).
 * Optional fields accept "" from HTML forms as "absent". `listingType` scopes
 * the schema to fields applicable to that listing's type.
 */
export function buildRfqSchema(
  config: VerticalConfig,
  listingType?: string,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of rfqFieldsFor(config, listingType)) {
    shape[field.key] = field.required
      ? field.schema
      : z.preprocess(
          (v) => (v === "" || v === undefined ? undefined : v),
          field.schema.optional(),
        );
  }
  return z.object(shape).strip();
}

/**
 * `fields` minus contact keys (email/tel) — what an operator may see about a
 * buyer before a deal is accepted (QA-152). Raw contact channels bypass the
 * marketplace fee, so they stay masked until deal-close.
 */
export function nonContactFields(
  config: VerticalConfig,
  listingType: ListingTypeSlug | undefined,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const hidden = new Set(
    rfqFieldsFor(config, listingType)
      .filter((f) => f.type === "email" || f.type === "tel")
      .map((f) => f.key),
  );
  return Object.fromEntries(
    Object.entries(fields).filter(([k]) => !hidden.has(k)),
  );
}
