"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

export function RfqSpamButton({ rfqId }: { rfqId: string }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function moderate() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/admin/rfqs/${rfqId}/status`, {
        body: { status: "spam" },
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
        onClick={moderate}
        disabled={pending}
        data-testid={`mod-rfq-spam-${rfqId}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {t("markSpam")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`mod-rfq-error-${rfqId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}

/** QA-525: force-close a live-but-legit RFQ — distinct from spam (which
 *  silently bins junk): closes the request, declines its open quotes and
 *  mails the buyer. Single click like the spam button — the change is
 *  destructive either way and both land in the audit feed. */
export function RfqCloseButton({ rfqId }: { rfqId: string }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function moderate() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/admin/rfqs/${rfqId}/status`, {
        body: { status: "closed" },
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
        onClick={moderate}
        disabled={pending}
        data-testid={`mod-rfq-close-${rfqId}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {t("closeRfq")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`mod-rfq-close-error-${rfqId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
