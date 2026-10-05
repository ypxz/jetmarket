"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { errText } from "@/lib/error-catalog";

/**
 * Demand-radar flush (QA-564): sends the queued saved-search digests for
 * this demand signature immediately — the admin's answer to "I just
 * seeded inventory matching this backlog, don't make buyers wait 20h".
 * The signature is server-re-derived; the page refresh lands the row at
 * backlog 0 on success.
 */
export function DemandFlushButton({ signature }: { signature: string }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function flush() {
    if (pending || done !== null) return;
    setPending(true);
    try {
      const res = await fetch("/api/admin/search-alerts/flush", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature }),
      });
      const data = (await res.json().catch(() => null)) as {
        sent?: number;
        cleared?: number;
        error?: string;
      } | null;
      if (!res.ok) {
        setError(errText(data, tc("error")));
        return;
      }
      setError(null);
      setDone((data?.sent ?? 0) + (data?.cleared ?? 0));
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  if (done !== null) {
    return (
      <span className="text-xs text-muted" data-testid="demand-flushed">
        {t("demandFlushed", { count: done })}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        onClick={flush}
        disabled={pending}
        data-testid="demand-flush"
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {pending ? t("demandFlushing") : t("demandFlush")}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-[color:var(--color-danger)]">
          {error}
        </span>
      ) : null}
    </span>
  );
}
