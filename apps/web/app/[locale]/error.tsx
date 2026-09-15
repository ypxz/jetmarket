"use client";

import { useTranslations } from "next-intl";

export default function ErrorPage({ reset }: { reset: () => void }) {
  const t = useTranslations("errors");
  const tc = useTranslations("common");
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold">{t("genericTitle")}</h1>
      <p className="mt-2 text-sm text-muted">{t("generic")}</p>
      <button
        onClick={reset}
        className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        {tc("retry")}
      </button>
    </main>
  );
}
