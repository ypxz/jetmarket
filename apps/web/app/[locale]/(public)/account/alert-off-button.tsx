"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** QA-473: session-authed turn-off for a saved search. The route takes the
 *  mailbox proof from the session cookie — no bearer token needed. */
export function AlertOffButton({ alertId }: { alertId: string }) {
  const t = useTranslations("account");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (done) {
    return (
      <span className="text-xs text-muted" data-testid={`alert-off-done-${alertId}`}>
        {t("alertOffDone")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        data-testid={`alert-off-${alertId}`}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm disabled:opacity-50"
        onClick={async () => {
          setPending(true);
          setError(null);
          const e = await sendAction(`/api/search-alerts/${alertId}/off`, {
            fallback: t("alertOffFailed"),
          });
          setPending(false);
          if (e) setError(e);
          else setDone(true);
        }}
      >
        {pending ? t("alertOffPending") : t("alertOff")}
      </button>
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
