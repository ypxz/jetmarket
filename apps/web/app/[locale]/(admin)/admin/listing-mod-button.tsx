"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

export function ListingModButton({
  listingId,
  status,
  action,
}: {
  listingId: string;
  status: string;
  action: "paused" | "archived";
}) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function moderate() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/admin/listings/${listingId}/status`, {
        body: { status: action },
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
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        onClick={moderate}
        data-testid={`mod-${action}-${listingId}`}
        disabled={status === action || pending}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-40"
      >
        {action === "paused" ? t("pauseListing") : t("archiveListing")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`mod-${action}-error-${listingId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
