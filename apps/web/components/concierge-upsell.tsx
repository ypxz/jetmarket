"use client";

import { Button } from "@jetmarket/ui";
import { readJsonOr } from "@/lib/fetch-json";
import { useEffect, useState } from "react";

function bearerToken(): string {
  return (
    new URLSearchParams(window.location.hash.slice(1)).get("t") ??
    new URLSearchParams(window.location.search).get("t") ??
    ""
  );
}

interface Props {
  rfqId: string;
  buyerEmail: string;
  /** Current paid flag + RFQ status — the parent already holds them (the
   *  thanks card fetches once for its RFQ; the quotes page has the row). */
  concierge: boolean;
  status: string;
  /** Bearer token when the parent already resolved it; otherwise the
   *  fragment/`?t=` is read at mount + click (same rule as
   *  ThanksQuotesLink). */
  token?: string;
  onApplied?: () => void;
  labels: { cta: string; busy: string; done: string; error: string };
}

/**
 * "Expedite my request — $49" — the buyer-concierge upsell. POSTs the
 * bearer-token-authorized concierge route; mock checkout applies instantly,
 * a real provider answers with a hosted `checkoutUrl` to redirect to.
 * Renders the "Concierge" badge once paid; nothing at all when the RFQ is
 * terminal (a dead request can't be expedited).
 */
export function ConciergeUpsell({
  rfqId,
  buyerEmail,
  concierge,
  status,
  token,
  onApplied,
  labels,
}: Props) {
  // Hydration gate — a pre-hydration submit natively POSTs the page route
  // (same convention as every client form, QA-245).
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(concierge);
  const [error, setError] = useState(false);
  useEffect(() => {
    setReady(true);
    setDone(concierge);
  }, [concierge]);

  if (!["open", "matched", "quoted"].includes(status)) return null;
  if (done) {
    return (
      <span
        className="inline-flex items-center rounded-md bg-surface px-2 py-0.5 text-xs font-medium text-success"
        data-testid={`concierge-done-${rfqId}`}
      >
        {labels.done}
      </span>
    );
  }

  async function buy() {
    setBusy(true);
    setError(false);
    let res: Response;
    try {
      res = await fetch(`/api/rfqs/${rfqId}/concierge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          buyerEmail,
          token: token ?? bearerToken(),
        }),
      });
    } catch {
      setBusy(false);
      setError(true);
      return;
    }
    const data = await readJsonOr<{
      concierge?: boolean;
      checkoutUrl?: string | null;
      error?: string;
    }>(res, {});
    setBusy(false);
    if (!res.ok) {
      setError(true);
      return;
    }
    if (data.concierge) {
      setDone(true);
      onApplied?.();
    } else if (data.checkoutUrl) {
      // Real provider: hosted checkout — the webhook flips the flag.
      window.location.href = data.checkoutUrl;
    } else {
      setError(true);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!ready || busy}
        onClick={buy}
        data-testid={`concierge-cta-${rfqId}`}
      >
        {busy ? labels.busy : labels.cta}
      </Button>
      {error ? (
        <span className="text-xs text-danger" data-testid={`concierge-error-${rfqId}`}>
          {labels.error}
        </span>
      ) : null}
    </span>
  );
}
