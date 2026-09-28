import { z } from "zod";
import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { verticalConfig, verticalSlug } from "@/lib/vertical";

function stripSchema<T extends { schema: unknown }>(f: T): Omit<T, "schema"> {
  const { schema, ...rest } = f;
  void schema;
  return rest;
}

export interface AttributeView {
  key: string;
  labelKey: string;
  appliesTo: string[];
  unitKey?: string;
  /** Form control to render: enum → select, number → number, else text/date. */
  input: "select" | "number" | "text" | "date";
  required: boolean;
  /** Enum values; labels resolve via `categories.<value>` in the copy ns. */
  options?: string[];
}

// Describe a zod attribute schema for client-side form rendering: unwrap
// optional/default/effects wrappers, then map enum→select, number→number,
// string→text (or the config's inputType hint).
function describeAttribute(a: {
  key: string;
  labelKey: string;
  appliesTo: string[];
  unitKey?: string;
  inputType?: "date";
  schema: z.ZodTypeAny;
}): AttributeView {
  let s = a.schema;
  let required = true;
  for (;;) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) {
      required = false;
      s = s.unwrap() as z.ZodTypeAny;
    } else if (s instanceof z.ZodDefault) {
      required = false;
      s = s.removeDefault() as z.ZodTypeAny;
    } else if (s instanceof z.ZodEffects) {
      s = s.innerType() as z.ZodTypeAny;
    } else {
      break;
    }
  }
  const base = {
    key: a.key,
    labelKey: a.labelKey,
    appliesTo: a.appliesTo,
    ...(a.unitKey ? { unitKey: a.unitKey } : {}),
    required,
  };
  if (s instanceof z.ZodEnum) {
    return { ...base, input: "select", options: s.options as string[] };
  }
  if (s instanceof z.ZodNumber) return { ...base, input: "number" };
  return { ...base, input: a.inputType ?? "text" };
}

// Public, serializable view of the active vertical config (zod schemas stripped —
// clients re-validate with buildRfqSchema/getAttributesSchema server-side).
export async function GET(req: Request) {
  if (!rateLimit(`vertical:${clientIp(req)}`, 1200, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const c = verticalConfig();
  const res = ok({
    slug: verticalSlug(),
    name: c.name,
    currency: c.currency,
    listingTypes: c.listingTypes,
    facets: c.facets,
    rfqFields: c.rfqFields.map((f) => stripSchema(f)),
    attributes: c.attributes.map(describeAttribute),
    fees: c.fees,
    seo: { landingPages: c.seo.landingPages },
  });
  // The payload is identical for every user and only changes on deploy — let
  // browsers/CDNs reuse it so client mounts don't re-hit origin each time.
  res.headers.set(
    "Cache-Control",
    "public, max-age=300, stale-while-revalidate=600",
  );
  return res;
}
