"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

export function VerifyButton({
  operatorId,
  verified,
}: {
  operatorId: string;
  verified: boolean;
}) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/admin/operators/${operatorId}/verify`, {
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
        onClick={toggle}
        disabled={pending}
        data-testid={`verify-${operatorId}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {verified ? t("unverify") : t("verify")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`verify-error-${operatorId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
