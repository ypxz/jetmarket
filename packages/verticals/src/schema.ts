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
 * Compose the zod schema validating a buyer RFQ payload (`rfqs.fields` jsonb).
 * Optional fields accept "" from HTML forms as "absent". `listingType` scopes
 * the schema to fields applicable to that listing's type. Returns a
 * ZodEffects wrapper: object-level refinements (real calendar dates,
 * ordered `*From`/`*To` pairs) sit on top of the field shape.
 */
export function buildRfqSchema(
  config: VerticalConfig,
  listingType?: string,
): z.ZodEffects<z.ZodObject<Record<string, z.ZodTypeAny>>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of rfqFieldsFor(config, listingType)) {
    shape[field.key] = field.required
      ? field.schema
      : z.preprocess(
          (v) => (v === "" || v === undefined ? undefined : v),
          field.schema.optional(),
        );
  }
  const dateKeys = new Set(
    rfqFieldsFor(config, listingType)
      .filter((f) => f.type === "date")
      .map((f) => f.key),
  );
  return z
    .object(shape)
    .strip()
    .superRefine((data, ctx) => {
      for (const key of dateKeys) {
        const v = data[key];
        if (v === undefined || v === null) continue;
        if (typeof v === "string" && !isRealIsoDate(v)) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "expected a valid calendar date",
          });
        }
      }
      // Any `xFrom`/`xTo` date pair must be ordered — an RFQ window that
      // ends before it starts is nonsense no operator can fulfill.
      for (const key of dateKeys) {
        if (!key.endsWith("From")) continue;
        const toKey = `${key.slice(0, -4)}To`;
        if (!dateKeys.has(toKey)) continue;
        const a = data[key];
        const b = data[toKey];
        if (typeof a === "string" && typeof b === "string" && a > b) {
          ctx.addIssue({
            code: "custom",
            path: [toKey],
            message: `must be on or after ${key}`,
          });
        }
      }
    });
}

/** `/^\d{4}-\d{2}-\d{2}$/` still admits 9999-99-99 — round-trip through UTC
 *  so only real calendar dates pass. */
function isRealIsoDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return true; // non-ISO values are the field schema's own concern
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
  );
}

/**
 * Shared ISO-date schema for vertical field/attribute configs: shape AND
 * calendar validity (regex alone accepts 2026-13-40 — QA-197).
 */
export function isoDate() {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected ISO date")
    .refine(isRealIsoDate, "expected a valid calendar date");
}

/**
 * Keys that must never reach an operator pre-deal — every rfqField carrying
 * `type: "email"|"tel"` OR `groupKey: "contact"` (the group tag catches a
 * contact field that forgets the channel type; QA-308). Covers the config's
 * whole rfqFields list: contact shape is deployment-wide.
 */
export function contactFieldKeys(config: VerticalConfig): Set<string> {
  return new Set(
    config.rfqFields
      .filter(
        (f) =>
          f.type === "email" || f.type === "tel" || f.groupKey === "contact",
      )
      .map((f) => f.key),
  );
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
