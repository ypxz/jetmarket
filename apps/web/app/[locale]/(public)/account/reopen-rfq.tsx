"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** QA-540: reopen a closed request from the account page — the twin of
 *  QA-475's withdraw. Session auth proves the mailbox; the route's CAS
 *  flips closed → open and the row badge reloads live. */
export function ReopenRfq({
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
      <span className="text-xs text-muted" data-testid={`account-rfq-reopened-${rfqId}`}>
        {t("reopenedMsg")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        data-testid={`account-rfq-reopen-${rfqId}`}
        className="rounded-md border border-border bg-background px-2.5 py-1 text-xs disabled:opacity-50"
        onClick={async () => {
          setPending(true);
          setError(null);
          const e = await sendAction(`/api/rfqs/${rfqId}/reopen`, {
            body: { buyerEmail },
            fallback: t("reopenFailed"),
          });
          setPending(false);
          if (e) setError(e);
          else setDone(true);
        }}
      >
        {pending ? t("reopening") : t("reopen")}
      </button>
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
