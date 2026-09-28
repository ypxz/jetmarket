"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

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
  const router = useRouter();
  async function moderate() {
    try {
      await fetch(`/api/admin/listings/${listingId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: action }),
      });
      router.refresh();
    } catch {
      // network error — leave the row untouched; admin can retry
    }
  }
  return (
    <button
      onClick={moderate}
      data-testid={`mod-${action}-${listingId}`}
      disabled={status === action}
      className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-40"
    >
      {action === "paused" ? t("pauseListing") : t("archiveListing")}
    </button>
  );
}
