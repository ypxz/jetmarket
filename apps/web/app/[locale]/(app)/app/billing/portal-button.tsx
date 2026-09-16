"use client";

import { readJson } from "@/lib/fetch-json";
import { useTranslations } from "next-intl";
import { useState } from "react";

export function PortalButton() {
  const t = useTranslations("app.billing");
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");

  async function openPortal() {
    setState("busy");
    const res = await fetch("/api/billing/portal", { method: "POST" });
    const data = await readJson<{ url?: string }>(res);
    if (!res.ok || !data.url) {
      setState("error");
      return;
    }
    window.location.assign(data.url);
  }

  return (
    <button
      onClick={openPortal}
      disabled={state === "busy"}
      data-testid="billing-portal"
      className="mt-2 w-full rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-surface disabled:opacity-50"
    >
      {state === "busy" ? t("opening") : state === "error" ? t("failed") : t("manageSub")}
    </button>
  );
}
