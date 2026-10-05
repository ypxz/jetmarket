"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** QA-542: pause/resume a saved search from /account — a session-side
 *  mute that keeps the row (and any queued digest backlog), unlike 'off'
 *  which retires it. router.refresh() re-renders the server badge so the
 *  flip stays consistent across the row. */
export function AlertPauseToggle({
  alertId,
  paused,
}: {
  alertId: string;
  paused: boolean;
}) {
  const t = useTranslations("account");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        data-testid={
          paused ? `alert-resume-${alertId}` : `alert-pause-${alertId}`
        }
        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm disabled:opacity-50"
        onClick={async () => {
          setPending(true);
          setError(null);
          const e = await sendAction(
            `/api/search-alerts/${alertId}/${paused ? "resume" : "pause"}`,
            {
              fallback: paused
                ? t("alertResumeFailed")
                : t("alertPauseFailed"),
            },
          );
          setPending(false);
          if (e) setError(e);
          else router.refresh();
        }}
      >
        {pending
          ? paused
            ? t("alertResuming")
            : t("alertPausing")
          : paused
            ? t("alertResume")
            : t("alertPause")}
      </button>
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
