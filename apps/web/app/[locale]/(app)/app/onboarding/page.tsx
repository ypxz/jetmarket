"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function OnboardingPage() {
  const t = useTranslations("app.onboarding");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const res = await fetch("/api/operators", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: f.get("name"),
        baseAirport: f.get("baseAirport"),
        fleetSummary: f.get("fleetSummary"),
      }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? t("failed"));
      return;
    }
    router.push("/app");
    router.refresh();
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-2 text-sm text-muted">{t("subtitle")}</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <input
          name="name"
          required
          placeholder={t("name")}
          data-testid="operator-name-input"
          className="w-full rounded-md border border-border bg-background px-3 py-2"
        />
        <input
          name="baseAirport"
          required
          placeholder={t("baseAirport")}
          maxLength={8}
          data-testid="operator-base-input"
          className="w-full rounded-md border border-border bg-background px-3 py-2"
        />
        <textarea
          name="fleetSummary"
          placeholder={t("fleetSummary")}
          data-testid="operator-fleet-input"
          className="w-full rounded-md border border-border bg-background px-3 py-2"
        />
        <button
          type="submit"
          data-testid="operator-save"
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
        >
          {t("save")}
        </button>
        {error ? <p className="text-sm text-[color:var(--color-danger)]">{error}</p> : null}
      </form>
    </main>
  );
}
