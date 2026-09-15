"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useState } from "react";
import { formatMoney } from "@/lib/format";

interface Quote {
  id: string;
  amount: number;
  currency: string;
  message: string;
  status: string;
  operator: { name: string; verified: boolean } | null;
}
interface Rfq {
  id: string;
  status: string;
  buyerEmail: string;
  createdAt: string;
  listing: { title: string; currency: string } | null;
  quotes: Quote[];
}

function QuotesInner() {
  const t = useTranslations("quotes");
  const tc = useTranslations("common");
  const params = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [rfqs, setRfqs] = useState<Rfq[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load(e?: React.FormEvent) {
    e?.preventDefault();
    const res = await fetch(`/api/buyer/quotes?email=${encodeURIComponent(email)}`);
    setRfqs(await res.json());
  }

  async function accept(quoteId: string) {
    const res = await fetch(`/api/quotes/${quoteId}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyerEmail: email }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMsg(data.error ?? tc("error"));
      return;
    }
    setMsg(t("accepted", { id: data.deal.id }));
    await load();
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <form onSubmit={load} className="mt-4 flex gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("emailLabel")}
          data-testid="buyer-email"
          className="w-72 rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" data-testid="buyer-load">
          {t("load")}
        </button>
      </form>
      {msg ? <p className="mt-4 rounded-md bg-surface p-3 text-sm" data-testid="accept-msg">{msg}</p> : null}
      {rfqs ? (
        rfqs.length === 0 ? (
          <p className="mt-6 text-sm text-muted">{t("empty")}</p>
        ) : (
          <ul className="mt-6 space-y-4">
            {rfqs.map((r) => (
              <li key={r.id} className="rounded-md border border-border p-4" data-testid={`buyer-rfq-${r.id}`}>
                <div className="flex justify-between">
                  <div className="font-medium">{r.listing?.title}</div>
                  <span className="text-xs text-muted">{r.status}</span>
                </div>
                {r.quotes.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">{t("waiting")}</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {r.quotes.map((q) => (
                      <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface p-3" data-testid={`quote-${q.id}`}>
                        <div>
                          <span className="font-medium">
                            {formatMoney(q.amount, q.currency)}
                          </span>{" "}
                          <span className="text-sm text-muted">
                            {t("by", { name: q.operator?.name ?? "" })}
                            {q.operator?.verified ? ` (${tc("verified")})` : ` (${tc("unverified")})`} · {q.status}
                          </span>
                          {q.message ? <p className="mt-1 text-sm">{q.message}</p> : null}
                        </div>
                        {q.status === "sent" ? (
                          <button
                            onClick={() => accept(q.id)}
                            data-testid={`accept-${q.id}`}
                            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                          >
                            {t("accept")}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </main>
  );
}

export default function QuotesPage() {
  return (
    <Suspense>
      <QuotesInner />
    </Suspense>
  );
}
