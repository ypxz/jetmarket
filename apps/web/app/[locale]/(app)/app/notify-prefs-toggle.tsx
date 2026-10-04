"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** Mail mute switch (QA-505): off = matches still land in the inbox but the
 *  "new/amended RFQ" emails stop; matches are unaffected. Hydration-gated
 *  like every sendAction. */
export function NotifyPrefsToggle({ on }: { on: boolean }) {
  const t = useTranslations("app.dashboard");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function flip() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction("/api/operator/notify-prefs", {
        method: "POST",
        body: { rfqMatch: !on },
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
        onClick={flip}
        disabled={pending}
        data-testid="notify-prefs-toggle"
        className="text-sm font-medium text-muted hover:text-foreground"
      >
        {on ? t("muteRfqMail") : t("unmuteRfqMail")}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
