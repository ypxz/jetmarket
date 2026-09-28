"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export function MarkPaidButton({ dealId }: { dealId: string }) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function markPaid() {
    if (pending) return;
    setPending(true);
    try {
      await fetch(`/api/admin/deals/${dealId}/paid`, { method: "POST" });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      onClick={markPaid}
      disabled={pending}
      data-testid={`mark-paid-${dealId}`}
      className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
    >
      {pending ? t("markingPaid") : t("markPaid")}
    </button>
  );
}

export function VoidInvoiceButton({ dealId }: { dealId: string }) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function voidInvoice() {
    if (pending) return;
    setPending(true);
    try {
      await fetch(`/api/admin/deals/${dealId}/void`, { method: "POST" });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      onClick={voidInvoice}
      disabled={pending}
      data-testid={`void-invoice-${dealId}`}
      className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
    >
      {pending ? t("voiding") : t("voidInvoice")}
    </button>
  );
}
