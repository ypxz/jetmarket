"use client";

import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

export function UpgradeButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");

  async function upgrade() {
    setState("busy");
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    });
    if (!res.ok) {
      setState("error");
      return;
    }
    router.refresh();
  }

  return (
    <button
      onClick={upgrade}
      disabled={state === "busy"}
      data-testid="checkout-pro"
      className="mt-3 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
    >
      {state === "busy" ? "Processing mock checkout…" : state === "error" ? "Failed — retry" : "Upgrade with mock checkout"}
    </button>
  );
}
