"use client";

import { errText } from "@/lib/error-catalog";
import { readJsonOr } from "@/lib/fetch-json";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

/**
 * "Rate the buyer" on a closed deal row (QA-528) — the operator's once-ever
 * 1-5 score; the aggregate lands on the buyer's email and marks their next
 * request "rated buyer" in every operator inbox. Rendered only while the
 * deal is unrated — a rated row shows the score read-only instead.
 */
export function RateBuyer({ dealId }: { dealId: string }) {
  const t = useTranslations("app.dashboard");
  const tc = useTranslations("common");
  const router = useRouter();
  const [rating, setRating] = useState(5);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rate() {
    if (pending) return;
    setPending(true);
    setError(null);
    let res: Response;
    try {
      res = await fetch(`/api/operator/deals/${dealId}/rate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating }),
      });
    } catch {
      setPending(false);
      setError(tc("error"));
      return;
    }
    setPending(false);
    if (!res.ok) {
      setError(
        errText(
          await readJsonOr<{ error?: string; code?: string }>(res, {}),
          tc("error"),
        ),
      );
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-1">
      <select
        aria-label={t("rateBuyerAria")}
        value={rating}
        onChange={(e) => setRating(Number(e.target.value))}
        data-testid={`rate-buyer-stars-${dealId}`}
        className="rounded-md border border-border bg-background px-1.5 py-1 text-sm"
      >
        {[5, 4, 3, 2, 1].map((n) => (
          <option key={n} value={n}>
            {n}★
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={rate}
        disabled={pending}
        data-testid={`rate-buyer-${dealId}`}
        className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
      >
        {pending ? t("rating") : t("rateBuyer")}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-[color:var(--color-danger)]">
          {error}
        </span>
      ) : null}
    </span>
  );
}
