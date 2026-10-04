"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** QA-475: session-authed withdraw for a live request — the same
 *  POST /api/rfqs/[id]/close the token inbox uses (session proves the
 *  mailbox, QA-474). Rows flip to a closed note in place. */
export function WithdrawRfq({
  rfqId,
  buyerEmail,
}: {
  rfqId: string;
  buyerEmail: string;
}) {
  const t = useTranslations("account");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (done) {
    return (
      <span className="text-xs text-muted" data-testid={`account-rfq-withdrawn-${rfqId}`}>
        {t("withdrawnMsg")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        data-testid={`account-rfq-withdraw-${rfqId}`}
        className="rounded-md border border-border bg-background px-2.5 py-1 text-xs disabled:opacity-50"
        onClick={async () => {
          setPending(true);
          setError(null);
          const e = await sendAction(`/api/rfqs/${rfqId}/close`, {
            body: { buyerEmail },
            fallback: t("withdrawFailed"),
          });
          setPending(false);
          if (e) setError(e);
          else setDone(true);
        }}
      >
        {pending ? t("withdrawing") : t("withdraw")}
      </button>
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
