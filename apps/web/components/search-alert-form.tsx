"use client";

import { Button, Input } from "@jetmarket/ui";
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
  submitLabel,
  sendingLabel,
  sentLabel,
  errorLabel,
  freqInstantLabel,
  freqDailyLabel,
}: {
  params: Record<string, string | string[] | undefined>;
  title: string;
  emailPlaceholder: string;
  submitLabel: string;
  sendingLabel: string;
  sentLabel: string;
  errorLabel: string;
  freqInstantLabel: string;
  freqDailyLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
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
        body: JSON.stringify({ email, params, freq }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? errorLabel);
        return;
      }
      setSent(true);
    } catch {
      setError(errorLabel);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p
        className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
        data-testid="search-alert-sent"
      >
        {sentLabel}
      </p>
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
