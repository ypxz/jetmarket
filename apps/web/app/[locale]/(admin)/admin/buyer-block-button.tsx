"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/**
 * Buyer email block toggle (QA-463) — the account-level kill beside the
 * per-RFQ spam mark. Toggles block/unblock on the address itself.
 */
export function BuyerBlockButton({
  email,
  blocked,
}: {
  email: string;
  blocked: boolean;
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
      const e = await sendAction("/api/admin/buyers/block", {
        body: { email },
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
        data-testid={`block-buyer-${email}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {blocked ? t("unblockBuyer") : t("blockBuyer")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`block-buyer-error-${email}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
