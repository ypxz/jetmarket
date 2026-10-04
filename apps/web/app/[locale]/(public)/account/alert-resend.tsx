"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** QA-476: pending alert never confirmed? Re-subscribing with the same
 *  params is the documented resend path — dedupe rotates the bearer token
 *  and re-mails the confirm link (per-inbox rate limits still apply). */
export function AlertResend({
  email,
  params,
  freq,
  alertId,
}: {
  email: string;
  params: Record<string, unknown>;
  freq: string;
  alertId: string;
}) {
  const t = useTranslations("account");
  // QA-493: resend keeps the page locale — the route stamps it on the row.
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (done) {
    return (
      <span className="text-xs text-muted" role="status">
        {t("resendDone")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        data-testid={`alert-resend-${alertId}`}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm disabled:opacity-50"
        onClick={async () => {
          setPending(true);
          setError(null);
          const e = await sendAction("/api/search-alerts", {
            body: { email, params, freq, locale },
            fallback: t("resendFailed"),
          });
          setPending(false);
          if (e) setError(e);
          else setDone(true);
        }}
      >
        {pending ? t("resendPending") : t("resendConfirm")}
      </button>
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
