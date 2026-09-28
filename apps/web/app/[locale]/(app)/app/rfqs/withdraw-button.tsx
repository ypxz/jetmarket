"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

export function WithdrawButton({ quoteId }: { quoteId: string }) {
  const t = useTranslations("app.rfqs");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/quotes/${quoteId}/withdraw`, {
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
        onClick={withdraw}
        disabled={pending}
        data-testid={`withdraw-${quoteId}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {pending ? t("withdrawing") : t("withdraw")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`withdraw-error-${quoteId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
