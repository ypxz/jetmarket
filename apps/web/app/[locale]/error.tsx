"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errors");
  const tc = useTranslations("common");
  useEffect(() => {
    // Beacon the crash — otherwise a client-side React error leaves no
    // server-side trace at all (QA-335).
    navigator.sendBeacon(
      "/api/client-error",
      JSON.stringify({
        digest: error.digest,
        message: error.message.slice(0, 500),
        path: window.location.pathname,
      }),
    );
  }, [error]);
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
