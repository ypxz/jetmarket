"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export function WithdrawButton({ quoteId }: { quoteId: string }) {
  const t = useTranslations("app.rfqs");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function withdraw() {
    if (pending) return;
    setPending(true);
    await fetch(`/api/quotes/${quoteId}/withdraw`, { method: "POST" });
    router.refresh();
    setPending(false);
  }

  return (
    <button
      onClick={withdraw}
      disabled={pending}
      data-testid={`withdraw-${quoteId}`}
      className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
    >
      {pending ? t("withdrawing") : t("withdraw")}
    </button>
  );
}
