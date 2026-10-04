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
