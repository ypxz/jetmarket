"use client";

import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

export function QuoteForm({ rfqId }: { rfqId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const res = await fetch("/api/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rfqId,
        amount: Number(f.get("amount")),
        message: f.get("message"),
      }),
    });
    setSending(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "failed");
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2">
      <input
        name="amount"
        type="number"
        required
        min={1}
        placeholder="Quote amount"
        data-testid={`quote-amount-${rfqId}`}
        className="w-40 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
      />
      <input
        name="message"
        placeholder="Message (optional)"
        className="min-w-48 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        disabled={sending}
        data-testid={`quote-send-${rfqId}`}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {sending ? "Sending…" : "Send quote"}
      </button>
      {error ? <span className="text-sm text-[color:var(--color-danger)]">{error}</span> : null}
    </form>
  );
}
