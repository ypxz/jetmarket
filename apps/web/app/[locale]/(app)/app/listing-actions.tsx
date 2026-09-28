"use client";

import { Link, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Listing } from "@/lib/repo/types";

export function ListingActions({ listing }: { listing: Pick<Listing, "id" | "status"> }) {
  const t = useTranslations("app.dashboard");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function patch(status: "active" | "paused" | "archived") {
    if (pending) return;
    setPending(true);
    await fetch(`/api/listings/${listing.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    router.refresh();
    setPending(false);
  }

  const btn =
    "rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50";
  return (
    <span className="flex gap-1">
      {listing.status !== "archived" ? (
        <Link
          href={`/app/listings/${listing.id}/edit`}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface"
          data-testid={`edit-listing-${listing.id}`}
        >
          {t("edit")}
        </Link>
      ) : null}
      {listing.status === "active" ? (
        <button
          className={btn}
          disabled={pending}
          data-testid={`pause-listing-${listing.id}`}
          onClick={() => patch("paused")}
        >
          {t("pause")}
        </button>
      ) : null}
      {listing.status === "paused" || listing.status === "draft" ? (
        <button
          className={btn}
          disabled={pending}
          data-testid={`publish-listing-${listing.id}`}
          onClick={() => patch("active")}
        >
          {t("publish")}
        </button>
      ) : null}
      {listing.status !== "archived" ? (
        <button
          className={btn}
          disabled={pending}
          data-testid={`archive-listing-${listing.id}`}
          onClick={() => patch("archived")}
        >
          {t("archive")}
        </button>
      ) : null}
    </span>
  );
}
