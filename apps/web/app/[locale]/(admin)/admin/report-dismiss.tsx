"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** Shared dismiss control — one endpoint per report surface (QA-529). */
function DismissButton({
  endpoint,
  testid,
}: {
  endpoint: string;
  testid: string;
}) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(endpoint, { fallback: tc("error") });
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
        data-testid={testid}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {pending ? t("dismissingReport") : t("dismissReport")}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-[color:var(--color-danger)]">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** QA-461: dismisses a flag in the admin report queue (CAS — repeat 409s). */
export function DismissReportButton({ reportId }: { reportId: string }) {
  return (
    <DismissButton
      endpoint={`/api/admin/reports/${reportId}/dismiss`}
      testid={`dismiss-report-${reportId}`}
    />
  );
}

/** QA-529: same dismiss for the buyer quote-flag queue. */
export function DismissQuoteReportButton({ reportId }: { reportId: string }) {
  return (
    <DismissButton
      endpoint={`/api/admin/quote-reports/${reportId}/dismiss`}
      testid={`dismiss-quote-report-${reportId}`}
    />
  );
}

/** QA-539: same dismiss for the operator RFQ-flag queue. */
export function DismissRfqReportButton({ reportId }: { reportId: string }) {
  return (
    <DismissButton
      endpoint={`/api/admin/rfq-reports/${reportId}/dismiss`}
      testid={`dismiss-rfq-report-${reportId}`}
    />
  );
}
