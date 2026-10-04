"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** Away switch (QA-427): off = no NEW RFQs fan out to this operator; rows
 *  already in the inbox stay. Hydration-gated like every sendAction. */
export function AvailabilityToggle({
  accepting,
}: {
  accepting: boolean;
}) {
  const t = useTranslations("app.dashboard");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function flip() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction("/api/operator/availability", {
        method: "POST",
        body: { accepting: !accepting },
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
        data-testid="availability-toggle"
        className={
          accepting
            ? "text-sm font-medium text-muted hover:text-foreground"
            : "text-sm font-medium text-accent hover:underline"
        }
      >
        {accepting ? t("pauseRfqs") : t("resumeRfqs")}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
