"use client";

import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

export function MarkPaidButton({ dealId }: { dealId: string }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markPaid() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/admin/deals/${dealId}/paid`, {
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
        onClick={markPaid}
        disabled={pending}
        data-testid={`mark-paid-${dealId}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {pending ? t("markingPaid") : t("markPaid")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`mark-paid-error-${dealId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}

export function ClearRatingButton({ dealId }: { dealId: string }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function clearRating() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/admin/deals/${dealId}/clear-rating`, {
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
        onClick={clearRating}
        disabled={pending}
        data-testid={`clear-rating-${dealId}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {pending ? t("clearingRating") : t("clearRating")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`clear-rating-error-${dealId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}

export function VoidInvoiceButton({ dealId }: { dealId: string }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function voidInvoice() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/admin/deals/${dealId}/void`, {
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
        onClick={voidInvoice}
        disabled={pending}
        data-testid={`void-invoice-${dealId}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {pending ? t("voiding") : t("voidInvoice")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`void-invoice-error-${dealId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}

export function RevertDealButton({ dealId }: { dealId: string }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revert() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/admin/deals/${dealId}/revert`, {
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
        onClick={revert}
        disabled={pending}
        data-testid={`revert-deal-${dealId}`}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
      >
        {pending ? t("revertingDeal") : t("revertDeal")}
      </button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-danger"
          data-testid={`revert-deal-error-${dealId}`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}
