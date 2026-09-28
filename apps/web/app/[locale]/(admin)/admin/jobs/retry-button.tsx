"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

export function RetryJobButton({ jobId }: { jobId: string }) {
  const t = useTranslations("admin.jobs");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/admin/jobs/${jobId}/retry`, {
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
        onClick={retry}
        disabled={pending}
        data-testid={`retry-job-${jobId}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {pending ? t("retrying") : t("retry")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`retry-job-error-${jobId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
