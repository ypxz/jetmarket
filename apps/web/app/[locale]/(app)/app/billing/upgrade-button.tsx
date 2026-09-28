"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export function UpgradeButton() {
  const t = useTranslations("app.billing");
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");

  async function upgrade() {
    setState("busy");
    let res: Response;
    try {
      res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      });
    } catch {
      setState("error");
      return;
    }
    if (!res.ok) {
      setState("error");
      return;
    }
    const data = (await res.json()) as {
      subscribed?: boolean;
      checkoutUrl?: string;
    };
    // Mock providers auto-activate server-side — land on the success banner.
    // Real providers hand back a hosted checkout URL the browser must follow.
    if (data.subscribed) {
      router.push("/app/billing?checkout=success");
      return;
    }
    if (data.checkoutUrl) {
      window.location.assign(data.checkoutUrl);
      return;
    }
    setState("error");
  }

  return (
    <button
      onClick={upgrade}
      disabled={state === "busy"}
      data-testid="checkout-pro"
      className="mt-3 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
    >
      {state === "busy" ? t("processing") : state === "error" ? t("failed") : t("upgradeMock")}
    </button>
  );
}
