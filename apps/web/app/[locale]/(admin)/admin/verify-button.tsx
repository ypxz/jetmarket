"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

export function VerifyButton({
  operatorId,
  verified,
}: {
  operatorId: string;
  verified: boolean;
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  async function toggle() {
    try {
      await fetch(`/api/admin/operators/${operatorId}/verify`, { method: "POST" });
      router.refresh();
    } catch {
      // network error — leave the row untouched; admin can retry
    }
  }
  return (
    <button
      onClick={toggle}
      data-testid={`verify-${operatorId}`}
      className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface"
    >
      {verified ? t("unverify") : t("verify")}
    </button>
  );
}
