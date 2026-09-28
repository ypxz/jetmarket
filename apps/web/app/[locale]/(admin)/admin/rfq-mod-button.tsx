"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

export function RfqSpamButton({ rfqId }: { rfqId: string }) {
  const t = useTranslations("admin");
  const router = useRouter();
  async function moderate() {
    try {
      await fetch(`/api/admin/rfqs/${rfqId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "spam" }),
      });
      router.refresh();
    } catch {
      // network error — leave the row untouched; admin can retry
    }
  }
  return (
    <button
      onClick={moderate}
      data-testid={`mod-rfq-spam-${rfqId}`}
      className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface"
    >
      {t("markSpam")}
    </button>
  );
}
