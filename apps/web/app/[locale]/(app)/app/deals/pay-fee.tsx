"use client";

import { readJsonOr } from "@/lib/fetch-json";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * "Pay fee" on an invoiced deal row (QA-450). Mock mode settles instantly
 * through the pay route's emulated webhook; a real provider hands back the
 * hosted invoice URL for the client to open.
 */
export function PayFee({ dealId }: { dealId: string }) {
  const t = useTranslations("app.dashboard");
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");

  async function pay() {
    setState("busy");
    let res: Response;
    try {
      res = await fetch(`/api/deals/${dealId}/pay`, { method: "POST" });
    } catch {
      setState("error");
      return;
    }
    const data = await readJsonOr<{ paid?: boolean; invoiceUrl?: string }>(
      res,
      {},
    );
    if (!res.ok) {
      setState("error");
      return;
    }
    if (data.paid) {
      router.refresh();
      return;
    }
    if (data.invoiceUrl) {
      window.location.assign(data.invoiceUrl);
      return;
    }
    setState("error");
  }

  return (
    <button
      onClick={pay}
      disabled={state === "busy"}
      data-testid={`pay-fee-${dealId}`}
      className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
    >
      {state === "busy" ? t("paying") : state === "error" ? t("payFailed") : t("payFee")}
    </button>
  );
}
