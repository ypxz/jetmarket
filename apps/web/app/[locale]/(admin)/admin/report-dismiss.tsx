"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** QA-461: dismisses a flag in the admin report queue (CAS — repeat 409s). */
export function DismissReportButton({ reportId }: { reportId: string }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/admin/reports/${reportId}/dismiss`, {
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
        data-testid={`dismiss-report-${reportId}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {pending ? t("dismissingReport") : t("dismissReport")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`dismiss-report-error-${reportId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
