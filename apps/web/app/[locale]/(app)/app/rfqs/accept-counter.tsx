"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** QA-515: take the buyer's counter — one click closes the negotiation at
 *  THEIR number. Renders only while a live counter sits on a 'sent' quote
 *  (the server re-proves all of it). */
export function AcceptCounter({
  quoteId,
  amount,
}: {
  quoteId: string;
  amount: string;
}) {
  const t = useTranslations("app.rfqs");
  const tc = useTranslations("common");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hydration gate (QA-245): the form can't submit before React owns it.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const err = await sendAction(`/api/quotes/${quoteId}/accept-counter`, {
        method: "POST",
        fallback: tc("error"),
      });
      if (err) {
        setError(err);
        return;
      }
      setError(null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => {
          setConfirming((v) => !v);
          setError(null);
        }}
        data-testid={`accept-counter-${quoteId}`}
        className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
      >
        {confirming ? t("acceptCounterCancel") : t("acceptCounter", { amount })}
      </button>
      {confirming ? (
        <form onSubmit={submit} className="flex items-center gap-2">
          <span className="text-xs text-muted">{t("acceptCounterSure")}</span>
          <button
            type="submit"
            disabled={!ready || pending}
            data-testid={`accept-counter-yes-${quoteId}`}
            className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {pending ? t("acceptCounterWorking") : t("acceptCounterYes")}
          </button>
        </form>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`accept-counter-error-${quoteId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
