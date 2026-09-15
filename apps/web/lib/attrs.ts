import type { AttributeSchema, VerticalConfig } from "@jetmarket/verticals";

/** Attribute schemas applicable to a listing type, in config order. */
export function attrsFor(
  config: VerticalConfig,
  listingType: string,
): AttributeSchema[] {
  return config.attributes.filter((a) => a.appliesTo.includes(listingType));
}

/**
 * If the attribute is enum-like (backed by a facet's options), return the
 * i18n label key for a stored value; otherwise undefined.
 */
export function optionLabelKey(
  config: VerticalConfig,
  attr: AttributeSchema,
  value: string,
): string | undefined {
  for (const f of config.facets) {
    if (f.type === "enum" && f.attributeKey === attr.key) {
      const hit = f.options?.find((o) => o.value === value);
      if (hit) return hit.labelKey;
    }
  }
  return undefined;
}
