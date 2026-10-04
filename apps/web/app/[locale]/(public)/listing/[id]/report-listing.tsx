"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { sendAction } from "@/lib/fetch-action";

/**
 * Buyer report flag (QA-461) — collapsed to a quiet link by default; opening
 * it reveals the reason picker. A submitted flag lands in the admin queue,
 * not the operator's inbox.
 */
export function ReportListing({ listingId }: { listingId: string }) {
  const t = useTranslations("listing");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("misleading");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/listings/${listingId}/report`, {
        body: {
          reason,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        fallback: tc("error"),
      });
      if (e) {
        setError(e);
        return;
      }
      setError(null);
      setDone(true);
      setOpen(false);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p className="mt-2 text-xs text-muted" data-testid="report-sent">
        {t("reportSent")}
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-muted underline"
        data-testid="report-toggle"
      >
        {t("reportToggle")}
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-2">
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
            data-testid="report-reason"
          >
            <option value="misleading">{t("reportMisleading")}</option>
            <option value="unavailable">{t("reportUnavailable")}</option>
            <option value="scam">{t("reportScam")}</option>
            <option value="other">{t("reportOther")}</option>
          </select>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder={t("reportNotePlaceholder")}
            className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
            data-testid="report-note"
          />
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="w-fit rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
            data-testid="report-submit"
          >
            {pending ? t("reportSending") : t("reportSubmit")}
          </button>
          {error ? (
            <p
              role="alert"
              className="text-xs text-danger"
              data-testid="report-error"
            >
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
