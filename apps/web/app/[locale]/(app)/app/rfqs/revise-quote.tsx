"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** QA-439: revise a still-'sent' quote in place — amount + message — without
 *  the withdraw+lose detour. The server CAS re-checks everything (owner,
 *  sent, live RFQ) so a stale open form can't clobber a signed deal. */
export function ReviseQuote({
  quoteId,
  amount,
  currency,
  message,
}: {
  quoteId: string;
  amount: number;
  currency: string;
  message: string;
}) {
  const t = useTranslations("app.rfqs");
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hydration gate — a pre-hydration submit posts natively and loses the
  // body (QA-245 rule: every client form gates on mount).
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const f = new FormData(e.currentTarget);
      const err = await sendAction(`/api/quotes/${quoteId}/revise`, {
        body: {
          amount: Number(f.get("amount")),
          currency,
          message: String(f.get("message") ?? ""),
        },
        fallback: tc("error"),
      });
      if (err) {
        setError(err);
        return;
      }
      setError(null);
      setOpen(false);
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
          setOpen((v) => !v);
          setError(null);
        }}
        data-testid={`revise-${quoteId}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface"
      >
        {open ? t("reviseCancel") : t("revise")}
      </button>
      {open ? (
        <form
          onSubmit={submit}
          className="flex flex-wrap items-center gap-2"
          data-testid={`revise-form-${quoteId}`}
        >
          <input
            name="amount"
            type="number"
            min="1"
            step="any"
            required
            defaultValue={amount}
            data-testid={`revise-amount-${quoteId}`}
            className="w-28 rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
          <input
            name="message"
            type="text"
            maxLength={2000}
            defaultValue={message}
            placeholder={t("reviseMessage")}
            data-testid={`revise-message-${quoteId}`}
            className="w-40 rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
          <button
            type="submit"
            disabled={!ready || pending}
            data-testid={`revise-save-${quoteId}`}
            className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {pending ? t("revising") : t("reviseSave")}
          </button>
        </form>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`revise-error-${quoteId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
