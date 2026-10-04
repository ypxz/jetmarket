"use client";

import { readJsonOr } from "@/lib/fetch-json";
import { errText } from "@/lib/error-catalog";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

interface OperatorProfile {
  name: string;
  baseAirport: string;
  fleetSummary: string;
}

export default function OnboardingPage() {
  const t = useTranslations("app.onboarding");
  const tv = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // Field labels come from the active vertical's copy (base airport vs
  // yard/HQ location), resolved via /api/vertical like the listing form.
  const [vertical, setVertical] = useState<string>("jets");
  // POST /api/operators upserts by userId, so this form doubles as the
  // profile editor — prefill via GET so editing one field doesn't blank
  // the rest (fleetSummary was silently cleared otherwise).
  const [profile, setProfile] = useState<OperatorProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    fetch("/api/operators")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProfile(d ?? null))
      .catch(() => setProfile(null))
      .finally(() => setLoaded(true));
    fetch("/api/vertical")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.slug) setVertical(d.slug);
      })
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    let res: Response;
    try {
      res = await fetch("/api/operators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: f.get("name"),
          baseAirport: f.get("baseAirport"),
          fleetSummary: f.get("fleetSummary"),
        }),
      });
    } catch {
      setError(t("failed"));
      return;
    }
    if (!res.ok) {
      setError(
        errText(
          await readJsonOr<{ error?: string; code?: string }>(res, {}),
          t("failed"),
        ),
      );
      return;
    }
    router.push("/app");
    router.refresh();
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-2 text-sm text-muted">{t("subtitle")}</p>
      {loaded ? (
      <form onSubmit={submit} className="mt-6 space-y-4">
        <input
          name="name"
          required
          defaultValue={profile?.name ?? ""}
          aria-label={t("name")}
          placeholder={t("name")}
          data-testid="operator-name-input"
          className="w-full rounded-md border border-border bg-background px-3 py-2"
        />
        <input
          name="baseAirport"
          required
          defaultValue={profile?.baseAirport ?? ""}
          aria-label={tv(`vertical.${vertical}.operator.baseLabel`)}
          placeholder={tv(`vertical.${vertical}.operator.baseLabel`)}
          maxLength={60}
          data-testid="operator-base-input"
          className="w-full rounded-md border border-border bg-background px-3 py-2"
        />
        <textarea
          name="fleetSummary"
          defaultValue={profile?.fleetSummary ?? ""}
          aria-label={tv(`vertical.${vertical}.operator.fleetLabel`)}
          placeholder={tv(`vertical.${vertical}.operator.fleetLabel`)}
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
      ) : (
        <p className="mt-6 text-sm text-muted">…</p>
      )}
    </main>
  );
}
