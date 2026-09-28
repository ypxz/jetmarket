"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export function RetryJobButton({ jobId }: { jobId: string }) {
  const t = useTranslations("admin.jobs");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function retry() {
    if (pending) return;
    setPending(true);
    try {
      await fetch(`/api/admin/jobs/${jobId}/retry`, { method: "POST" });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      onClick={retry}
      disabled={pending}
      data-testid={`retry-job-${jobId}`}
      className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
    >
      {pending ? t("retrying") : t("retry")}
    </button>
  );
}
