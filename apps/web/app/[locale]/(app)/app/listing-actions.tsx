"use client";

import { Link, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";
import type { Listing } from "@/lib/repo/types";

export function ListingActions({ listing }: { listing: Pick<Listing, "id" | "status"> }) {
  const t = useTranslations("app.dashboard");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tc = useTranslations("common");

  async function patch(status: "active" | "paused" | "archived") {
    if (pending) return;
    setPending(true);
    try {
      // The server's reason matters — the 403 plan-cap message is the Pro
      // upsell and must not fail silently (QA-211).
      const e = await sendAction(`/api/listings/${listing.id}`, {
        method: "PATCH",
        body: { status },
        fallback: tc("error"),
      });
      if (e) {
        setError(e);
        return;
      }
      setError(null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const btn =
    "rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50";
  return (
    <span className="flex flex-wrap items-center gap-1">
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
      {error ? (
        <p
          role="alert"
          className="w-full text-xs text-danger"
          data-testid={`listing-action-error-${listing.id}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
