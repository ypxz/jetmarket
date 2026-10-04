"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** Inbox triage (QA-420): dismiss hides the RFQ from this operator's inbox
 *  only — other operators and the buyer still see it. */
export function DismissButton({ rfqId }: { rfqId: string }) {
  const t = useTranslations("app.rfqs");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/operator/rfqs/${rfqId}/dismiss`, {
        fallback: tc("error"),
      });
      if (e) {
        setError(e);
        return;
      }
      setError(null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        onClick={dismiss}
        disabled={pending}
        data-testid={`dismiss-rfq-${rfqId}`}
        className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface disabled:opacity-50"
      >
        {t("dismiss")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`dismiss-error-${rfqId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}

/** QA-438: one click clears every dismissable row in the current view —
 *  busy inboxes shouldn't triage row-by-row. Server re-proves each id, so
 *  this only ever carries the rows the page rendered. */
export function DismissAllButton({ rfqIds }: { rfqIds: string[] }) {
  const t = useTranslations("app.rfqs");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismissAll() {
    if (pending || rfqIds.length === 0) return;
    if (!window.confirm(t("dismissAllConfirm", { count: rfqIds.length })))
      return;
    setPending(true);
    try {
      const e = await sendAction("/api/operator/rfqs/dismiss-bulk", {
        body: { ids: rfqIds },
        fallback: tc("error"),
      });
      if (e) {
        setError(e);
        return;
      }
      setError(null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={dismissAll}
        disabled={pending}
        data-testid="dismiss-all"
        className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:bg-surface disabled:opacity-50"
      >
        {t("dismissAll", { count: rfqIds.length })}
      </button>
      {error ? (
        <p role="alert" className="text-xs text-danger" data-testid="dismiss-all-error">
          {error}
        </p>
      ) : null}
    </span>
  );
}

/** QA-421 "Dismissed" view counterpart: restore puts the RFQ back into the
 *  operator's normal inbox (DELETE on the same route). */
export function RestoreButton({ rfqId }: { rfqId: string }) {
  const t = useTranslations("app.rfqs");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/operator/rfqs/${rfqId}/dismiss`, {
        method: "DELETE",
        fallback: tc("error"),
      });
      if (e) {
        setError(e);
        return;
      }
      setError(null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        onClick={restore}
        disabled={pending}
        data-testid={`restore-rfq-${rfqId}`}
        className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface disabled:opacity-50"
      >
        {t("restore")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`restore-error-${rfqId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
