import { createHash } from "node:crypto";

/** Stable stringify: sorted object keys so field order never defeats dedupe. */
export function canonicalize(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Amend-path dedupe key (QA-481) — byte-identical to POST /api/rfqs'
 * formula: sha256(listingId|buyerEmailLower|canonical fields). Amending a
 * request INTO details the buyer already has live on this listing
 * collides with that twin's POST-minted key, and a repost of the amended
 * content dedupes to the amended row. `fields` MUST be the zod-parsed
 * field map (buildRfqSchema output) — POST keys on parsed.data, so
 * normalization defaults/coercions are part of the hash contract.
 */
export function rfqAmendDedupeKey(
  listingId: string,
  buyerEmail: string,
  fields: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(
      `${listingId}|${buyerEmail.toLowerCase()}|${canonicalize(fields)}`,
    )
    .digest("hex");
}
