import { ok } from "@/lib/api";
import { verticalConfig, verticalSlug } from "@/lib/vertical";

function stripSchema<T extends { schema: unknown }>(f: T): Omit<T, "schema"> {
  const { schema, ...rest } = f;
  void schema;
  return rest;
}

// Public, serializable view of the active vertical config (zod schemas stripped —
// clients re-validate with buildRfqSchema/getAttributesSchema server-side).
export async function GET() {
  const c = verticalConfig();
  return ok({
    slug: verticalSlug(),
    name: c.name,
    currency: c.currency,
    listingTypes: c.listingTypes,
    facets: c.facets,
    rfqFields: c.rfqFields.map((f) => stripSchema(f)),
    attributes: c.attributes.map((a) => stripSchema(a)),
    fees: c.fees,
    seo: { landingPages: c.seo.landingPages },
  });
}
