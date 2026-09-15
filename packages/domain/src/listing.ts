/**
 * Listing validation — attributes jsonb is checked against the zod schema the
 * VerticalConfig declares for that listing type (composed by
 * `getAttributesSchema` from packages/verticals). Core fields (title, photos,
 * price) are validated here too.
 */
import { z } from "zod";
import type { Currency } from "./money";
import type { ListingStatus } from "./types";
import { getAttributesSchema } from "./vertical-config";
import type { ListingTypeSlug, VerticalConfig } from "./vertical-config";

export const LISTING_STATUSES = [
  "draft",
  "active",
  "paused",
  "archived",
] as const satisfies readonly ListingStatus[];

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export interface ListingDraft {
  type: ListingTypeSlug;
  title: string;
  attributes: Record<string, unknown>;
  priceMinor: number | null;
  currency: Currency;
  status: ListingStatus;
  photos: string[];
}

const coreFields = z.object({
  type: z.string().min(1),
  title: z.string().trim().min(3).max(200),
  priceMinor: z.number().int().positive().nullable().default(null),
  currency: z.string().min(3).max(3).default("USD"),
  status: z.enum(LISTING_STATUSES).default("draft"),
  photos: z.array(z.string().min(1)).max(30).default([]),
});

export function listingTypeDeclared(
  config: Pick<VerticalConfig, "listingTypes">,
  listingType: string,
): boolean {
  return config.listingTypes.some((t) => t.slug === listingType);
}

/** Validate only the attributes jsonb for a listing type. */
export function validateListingAttributes(
  config: Pick<VerticalConfig, "attributes" | "listingTypes">,
  listingType: string,
  attributes: unknown,
): ValidationResult<Record<string, unknown>> {
  if (!listingTypeDeclared(config, listingType)) {
    return {
      ok: false,
      issues: [
        {
          path: "type",
          message: `unknown listing type "${listingType}" for vertical`,
        },
      ],
    };
  }
  const schema = getAttributesSchema(
    config as Pick<VerticalConfig, "attributes"> as VerticalConfig,
    listingType,
  );
  const parsed = schema.safeParse(attributes ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "attributes",
        message: i.message,
      })),
    };
  }
  return { ok: true, value: parsed.data as Record<string, unknown> };
}

export interface NewListingInput {
  type: string;
  title: string;
  attributes: unknown;
  priceMinor?: number | null;
  currency?: Currency;
  status?: ListingStatus;
  photos?: string[];
}

/**
 * Full new-listing validation: listing type must be declared by the vertical,
 * core fields must be sane, and attributes must satisfy the type's schema.
 * On success returns a normalized draft (defaults applied, unknown attribute
 * keys stripped).
 */
export function validateNewListing(
  config: Pick<VerticalConfig, "listingTypes" | "attributes" | "currency">,
  input: NewListingInput,
): ValidationResult<ListingDraft> {
  const issues: ValidationIssue[] = [];
  if (!listingTypeDeclared(config, input.type)) {
    issues.push({
      path: "type",
      message: `unknown listing type "${input.type}" for vertical`,
    });
  }
  const core = coreFields.safeParse({
    currency: config.currency,
    ...input,
    attributes: undefined,
  });
  if (!core.success) {
    issues.push(
      ...core.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  const attrs = validateListingAttributes(config, input.type, input.attributes);
  if (!attrs.ok) issues.push(...attrs.issues);

  if (issues.length > 0 || !core.success || !attrs.ok) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      type: core.data.type,
      title: core.data.title,
      attributes: attrs.value,
      priceMinor: core.data.priceMinor,
      currency: core.data.currency,
      status: core.data.status,
      photos: core.data.photos,
    },
  };
}
