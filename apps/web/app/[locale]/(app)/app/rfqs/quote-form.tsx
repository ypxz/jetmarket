"use client";

import { readJsonOr } from "@/lib/fetch-json";
import { errText } from "@/lib/error-catalog";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export function QuoteForm({ rfqId }: { rfqId: string }) {
  const t = useTranslations("app.rfqs");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Hydrated gate — pre-hydration submit posts natively (405). QA-245.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    let res: Response;
    try {
      res = await fetch("/api/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rfqId,
          amount: Number(f.get("amount")),
          message: f.get("message"),
        }),
      });
    } catch {
      setSending(false);
      setError(t("failed"));
      return;
    }
    setSending(false);
    if (!res.ok) {
      setError(
        errText(
          await readJsonOr<{ error?: string; code?: string }>(res, {}),
          t("failed"),
        ),
      );
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2">
      <input
        name="amount"
        type="number"
        required
        min={1}
        aria-label={t("amountPh")}
        placeholder={t("amountPh")}
        data-testid={`quote-amount-${rfqId}`}
        className="w-40 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
      />
      <input
        name="message"
        aria-label={t("messagePh")}
        placeholder={t("messagePh")}
        className="min-w-48 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        disabled={sending || !ready}
        data-testid={`quote-send-${rfqId}`}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {sending ? t("sending") : t("send")}
      </button>
      {error ? <span className="text-sm text-[color:var(--color-danger)]">{error}</span> : null}
    </form>
  );
}
