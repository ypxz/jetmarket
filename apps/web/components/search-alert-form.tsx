"use client";

import { useLocale } from "next-intl";

import { Button, Input } from "@jetmarket/ui";
import { errText } from "@/lib/error-catalog";
import { useEffect, useState } from "react";

/**
 * Saved-search subscribe widget (QA-403) — collapses to an email field;
 * POSTs the current filter set to /api/search-alerts. Labels arrive as
 * props from the server page (same pattern as RfqForm).
 */
export function SearchAlertForm({
  params,
  title,
  emailPlaceholder,
  emailDefault,
  submitLabel,
  sendingLabel,
  sentLabel,
  errorLabel,
  freqInstantLabel,
  freqDailyLabel,
  matchedLabel,
}: {
  params: Record<string, string | string[] | undefined>;
  title: string;
  emailPlaceholder: string;
  /** Pre-fills the email field (e.g. the buyer's RFQ contact on /rfq/thanks). */
  emailDefault?: string;
  submitLabel: string;
  sendingLabel: string;
  sentLabel: string;
  errorLabel: string;
  freqInstantLabel: string;
  freqDailyLabel: string;
  /** "{count}" is replaced with the API's live-match count (QA-415). */
  matchedLabel?: string;
}) {
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [matched, setMatched] = useState<number | null>(null);
  // Hydration gate — a pre-hydration submit POSTs natively to the page route.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") ?? "").trim();
    const freq = String(fd.get("freq") ?? "instant");
    try {
      const res = await fetch("/api/search-alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Digest + confirm mails keep the subscribe-page locale (QA-493).
        body: JSON.stringify({ email, params, freq, locale }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        code?: string;
        matchedNow?: number;
      } | null;
      if (!res.ok) {
        setError(errText(body, errorLabel));
        return;
      }
      setMatched(typeof body?.matchedNow === "number" ? body.matchedNow : null);
      setSent(true);
    } catch {
      setError(errorLabel);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div
        className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
        data-testid="search-alert-sent"
      >
        <p>{sentLabel}</p>
        {matched !== null && matchedLabel ? (
          <p className="mt-0.5 text-xs text-muted" data-testid="search-alert-matched">
            {matchedLabel.replace("{count}", String(matched))}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2"
      onSubmit={onSubmit}
      data-testid="search-alert-form"
    >
      <span className="text-sm font-medium">{title}</span>
      <Input
        type="email"
        name="email"
        required
        placeholder={emailPlaceholder}
        defaultValue={emailDefault}
        className="min-w-0 flex-1 sm:max-w-56"
        data-testid="search-alert-email"
      />
      <span className="flex items-center gap-2 text-xs text-muted">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="freq"
            value="instant"
            defaultChecked
            data-testid="search-alert-freq-instant"
          />
          {freqInstantLabel}
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="freq"
            value="daily"
            data-testid="search-alert-freq-daily"
          />
          {freqDailyLabel}
        </label>
      </span>
      <Button
        type="submit"
        disabled={busy || !ready}
        data-testid="search-alert-submit"
      >
        {busy ? sendingLabel : submitLabel}
      </Button>
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      ) : null}
    </form>
  );
}
