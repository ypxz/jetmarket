"use client";

import { Link, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";
import { errText } from "@/lib/error-catalog";
import type { Listing } from "@/lib/repo/types";

export function ListingActions({
  listing,
  oneOff = false,
}: {
  listing: Pick<Listing, "id" | "status">;
  /** One-off inventory types get a "mark sold" action (QA-498). */
  oneOff?: boolean;
}) {
  const t = useTranslations("app.dashboard");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"delete" | "sold" | null>(null);
  const tc = useTranslations("common");

  async function remove() {
    if (pending) return;
    // First click arms the confirm; second click actually deletes.
    if (confirming !== "delete") {
      setConfirming("delete");
      return;
    }
    setPending(true);
    try {
      const e = await sendAction(`/api/listings/${listing.id}`, {
        method: "DELETE",
        fallback: tc("error"),
      });
      if (e) {
        setError(e);
        setConfirming(null);
        return;
      }
      setError(null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function markSold() {
    if (pending) return;
    // Terminal like delete — arm first, fire on the second click.
    if (confirming !== "sold") {
      setConfirming("sold");
      return;
    }
    await patch("sold");
  }

  async function patch(status: "active" | "paused" | "archived" | "sold") {
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

  async function duplicate() {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch(`/api/listings/${listing.id}/duplicate`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          code?: string;
        } | null;
        setError(errText(data, tc("error")));
        return;
      }
      setError(null);
      const copy = (await res.json()) as { id?: string };
      // Land on the new draft's editor — the operator renames/publishes it.
      router.push(copy.id ? `/app/listings/${copy.id}/edit` : "/app");
    } catch {
      setError(tc("error"));
    } finally {
      setPending(false);
    }
  }

  const btn =
    "rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50";
  return (
    <span className="flex flex-wrap items-center gap-1">
      {/* Shown on every status incl. archived/sold — cloning is the revive path. */}
      <button
        className={btn}
        disabled={pending}
        data-testid={`duplicate-listing-${listing.id}`}
        onClick={duplicate}
      >
        {t("duplicate")}
      </button>
      {listing.status !== "archived" && listing.status !== "sold" ? (
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
      {listing.status !== "archived" && listing.status !== "sold" ? (
        <button
          className={btn}
          disabled={pending}
          data-testid={`archive-listing-${listing.id}`}
          onClick={() => patch("archived")}
        >
          {t("archive")}
        </button>
      ) : null}
      {/* One-off inventory sold off-platform (QA-498): terminal like archive
          but records the sale — two-click confirm. */}
      {oneOff &&
      (listing.status === "active" || listing.status === "paused") ? (
        <button
          className={btn}
          disabled={pending}
          data-testid={`sold-listing-${listing.id}`}
          onClick={markSold}
        >
          {confirming === "sold" ? t("markSoldConfirm") : t("markSold")}
        </button>
      ) : null}
      {/* Terminal rows only (draft/archived) — two-click confirm, the row
          is gone for good (QA-419). Sold stays: the row documents the deal. */}
      {listing.status === "draft" || listing.status === "archived" ? (
        <button
          className={btn}
          disabled={pending}
          data-testid={`delete-listing-${listing.id}`}
          onClick={remove}
        >
          {confirming === "delete" ? t("deleteConfirm") : t("delete")}
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
