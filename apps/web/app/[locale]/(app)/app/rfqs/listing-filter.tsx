"use client";

import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

/** QA-430: per-listing inbox triage — the "N requests" dashboard chip lands
 *  here with ?listing=<id>; the select re-arms the same param. */
export function ListingFilter({
  listings,
  active,
  f,
  sort,
  allLabel,
}: {
  listings: { id: string; title: string }[];
  active: string | null;
  f: string | null;
  /** QA-443: an active sort survives a listing-scope switch. */
  sort: string | null;
  allLabel: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  function go(listingId: string) {
    setPending(true);
    const q = new URLSearchParams();
    if (f) q.set("f", f);
    if (sort) q.set("sort", sort);
    if (listingId) q.set("listing", listingId);
    const s = q.toString();
    router.push(`/app/rfqs${s ? `?${s}` : ""}`);
  }

  if (listings.length === 0) return null;
  return (
    <select
      className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-muted disabled:opacity-50"
      value={active ?? ""}
      disabled={pending}
      data-testid="listing-filter"
      aria-label={allLabel}
      onChange={(e) => go(e.target.value)}
    >
      <option value="">{allLabel}</option>
      {listings.map((l) => (
        <option key={l.id} value={l.id}>
          {l.title}
        </option>
      ))}
    </select>
  );
}
