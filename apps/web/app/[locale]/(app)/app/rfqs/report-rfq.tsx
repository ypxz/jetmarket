"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { sendAction } from "@/lib/fetch-action";

/**
 * Operator RFQ flag (QA-469) — the demand-side twin of the buyer listing
 * report. Collapsed to a quiet link; opening it reveals the reason picker.
 * A submitted flag lands on the admin RFQ moderation rows as a
 * "flagged ×N" badge.
 */
export function ReportRfq({ rfqId }: { rfqId: string }) {
  const t = useTranslations("app.rfqs");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("spam");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/operator/rfqs/${rfqId}/report`, {
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
      <p className="text-xs text-muted" data-testid={`flag-sent-${rfqId}`}>
        {t("flagSent")}
      </p>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-muted underline"
        data-testid={`flag-toggle-${rfqId}`}
      >
        {t("flag")}
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-2">
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
            data-testid={`flag-reason-${rfqId}`}
          >
            <option value="spam">{t("flagSpam")}</option>
            <option value="abusive">{t("flagAbusive")}</option>
            <option value="duplicate">{t("flagDuplicate")}</option>
            <option value="other">{t("flagOther")}</option>
          </select>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder={t("flagNotePlaceholder")}
            className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
            data-testid={`flag-note-${rfqId}`}
          />
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="w-fit rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
            data-testid={`flag-submit-${rfqId}`}
          >
            {pending ? t("flagging") : t("flagSubmit")}
          </button>
          {error ? (
            <p
              role="alert"
              className="text-xs text-danger"
              data-testid={`flag-error-${rfqId}`}
            >
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
