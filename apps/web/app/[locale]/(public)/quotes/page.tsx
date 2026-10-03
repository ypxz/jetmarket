"use client";

import { ConciergeUpsell } from "@/components/concierge-upsell";
import { SavedSearchesList } from "@/components/saved-searches-list";
import { CONCIERGE_PRICE_USD } from "@jetmarket/config";
import { readJsonOr } from "@/lib/fetch-json";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
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
  concierge?: boolean;
  buyerEmail: string;
  createdAt: string;
  // Operators the request actually reached (delayed matches don't count).
  deliveredTo: number;
  listing: { id: string; title: string; currency: string; browseable?: boolean } | null;
  // Echo of the request's own spec fields ("Departure: TEB"), built
  // server-side in vertical field order — contact fields excluded.
  requestFields: { label: string; value: string }[];
  quotes: Quote[];
}

function QuotesInner() {
  const t = useTranslations("quotes");
  const tc = useTranslations("common");
  const params = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  // Bearer token: URL fragment first (`#t=` never reaches server logs or
  // Referer), legacy `?t=` fallback for links emailed before the fragment
  // form shipped (QA-240).
  const [token, setToken] = useState(params.get("t") ?? "");
  const [rfqs, setRfqs] = useState<Rfq[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // A pre-hydration submit posts the uncontrolled form natively (GET /quotes?
  // — email and the fragment token both lost). Gate the submit control until
  // effects have run so fast clicks can't outrun hydration (QA-240).
  const [ready, setReady] = useState(false);

  async function load(e?: React.FormEvent, tok?: string) {
    e?.preventDefault();
    const tk = tok ?? token;
    if (!tk) {
      setMsg(t("needLink"));
      return;
    }
    // Token rides a header, not the query string — bearer tokens in URLs
    // persist in server logs, history and Referer (QA-156).
    let res: Response;
    try {
      res = await fetch(
        `/api/buyer/quotes?email=${encodeURIComponent(email)}`,
        { headers: { "x-rfq-token": tk } },
      );
    } catch {
      setMsg(tc("error"));
      return;
    }
    if (!res.ok) {
      const d = await readJsonOr<{ error?: string }>(res, {});
      setMsg(d.error ?? tc("error"));
      return;
    }
    setRfqs(await readJsonOr<Rfq[]>(res, []));
  }

  // "Lost your link?" — re-emails every request's bearer link to the claimed
  // mailbox (QA-160). Server answers identically whether RFQs exist.
  async function resend() {
    if (!email) {
      setMsg(t("needEmail"));
      return;
    }
    let res: Response;
    try {
      res = await fetch("/api/buyer/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    const d = await readJsonOr<{ error?: string }>(res, {});
    setMsg(res.ok ? t("resendSent") : (d.error ?? tc("error")));
  }

  // Auto-load when arriving with ?email= (magic-link/thank-you redirect),
  // then drop any bearer token (query `t` or `#t=` fragment) from the
  // address bar so it doesn't sit in history.
  useEffect(() => {
    const hashToken = new URLSearchParams(window.location.hash.slice(1)).get(
      "t",
    );
    const effective = token || hashToken || "";
    if (hashToken && !token) setToken(hashToken);
    if (params.get("t") || hashToken) {
      const url = new URL(window.location.href);
      url.searchParams.delete("t");
      url.hash = "";
      window.history.replaceState(null, "", url.toString());
    }
    setReady(true);
    if (email) void load(undefined, effective);
    // mount-only: refresh via the search form; load re-creates per render
    // so it must not be a dep or the effect refetches every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function accept(quoteId: string) {
    let res: Response;
    try {
      res = await fetch(`/api/quotes/${quoteId}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyerEmail: email, token }),
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    const data = await readJsonOr<{ error?: string; deal?: { id: string } }>(res, {});
    if (!res.ok || !data.deal) {
      setMsg(data.error ?? tc("error"));
      return;
    }
    setMsg(t("accepted", { id: data.deal.id }));
    await load();
  }

  async function decline(quoteId: string) {
    let res: Response;
    try {
      res = await fetch(`/api/quotes/${quoteId}/decline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyerEmail: email, token }),
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    const data = await readJsonOr<{ error?: string }>(res, {});
    if (!res.ok) {
      setMsg(data.error ?? tc("error"));
      return;
    }
    setMsg(t("declinedMsg"));
    await load();
  }

  async function closeRfq(rfqId: string) {
    let res: Response;
    try {
      res = await fetch(`/api/rfqs/${rfqId}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyerEmail: email, token }),
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    const data = await readJsonOr<{ error?: string }>(res, {});
    if (!res.ok) {
      setMsg(data.error ?? tc("error"));
      return;
    }
    setMsg(t("closedMsg"));
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
        <button
          disabled={!ready}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          data-testid="buyer-load"
        >
          {t("load")}
        </button>
        <button
          type="button"
          onClick={resend}
          data-testid="buyer-resend"
          className="rounded-md border border-border bg-background px-4 py-2 text-sm"
        >
          {t("resend")}
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
                  <div className="font-medium">
                    {r.listing?.browseable ? (
                      <a
                        href={`/listing/${r.listing.id}`}
                        className="underline decoration-border underline-offset-4 hover:text-primary"
                        data-testid={`rfq-listing-${r.id}`}
                      >
                        {r.listing.title}
                      </a>
                    ) : (
                      r.listing?.title
                    )}
                  </div>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-muted" data-testid={`rfq-state-${r.id}`}>{tc(`rfqState.${r.status}`)}</span>
                    {r.concierge ? (
                      <span className="rounded-md bg-surface px-2 py-0.5 text-xs font-medium text-success" data-testid={`concierge-badge-${r.id}`}>
                        {t("concierge.done")}
                      </span>
                    ) : null}
                    {["open", "matched", "quoted"].includes(r.status) ? (
                      <button
                        onClick={() => closeRfq(r.id)}
                        data-testid={`close-rfq-${r.id}`}
                        className="rounded-md border border-border bg-background px-2 py-0.5 text-xs"
                      >
                        {t("close")}
                      </button>
                    ) : null}
                  </span>
                </div>
                {r.requestFields?.length ? (
                  <p className="mt-1 text-xs text-muted" data-testid={`rfq-echo-${r.id}`}>
                    {r.requestFields.map((f) => `${f.label}: ${f.value}`).join(" · ")}
                  </p>
                ) : null}
                {r.deliveredTo > 0 ? (
                  <p className="mt-1 text-xs text-muted" data-testid={`rfq-delivered-${r.id}`}>
                    {t("deliveredTo", { count: r.deliveredTo })}
                  </p>
                ) : null}
                {!r.concierge &&
                ["open", "matched", "quoted"].includes(r.status) ? (
                  <div className="mt-2">
                    <ConciergeUpsell
                      rfqId={r.id}
                      buyerEmail={r.buyerEmail}
                      concierge={!!r.concierge}
                      status={r.status}
                      token={token}
                      onApplied={() =>
                        setRfqs(
                          (prev) =>
                            prev?.map((x) =>
                              x.id === r.id ? { ...x, concierge: true } : x,
                            ) ?? prev,
                        )
                      }
                      labels={{
                        cta: t("concierge.cta", {
                          price: `$${CONCIERGE_PRICE_USD}`,
                        }),
                        busy: t("concierge.ctaBusy"),
                        done: t("concierge.done"),
                        error: t("concierge.error"),
                      }}
                    />
                  </div>
                ) : null}
                {r.quotes.length === 0 &&
                ["open", "matched", "quoted"].includes(r.status) ? (
                  <p className="mt-2 text-sm text-muted">{t("waiting")}</p>
                ) : null}
                {r.quotes.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {r.quotes.map((q) => (
                      <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface p-3" data-testid={`quote-${q.id}`}>
                        <div>
                          <span className="font-medium">
                            {formatMoney(q.amount, q.currency)}
                          </span>{" "}
                          <span className="text-sm text-muted">
                            {t("by", { name: q.operator?.name ?? "" })}
                            {q.operator?.verified ? ` (${tc("verified")})` : ` (${tc("unverified")})`} · {tc(`quoteState.${q.status}`)}
                          </span>
                          {q.message ? <p className="mt-1 text-sm">{q.message}</p> : null}
                        </div>
                        {q.status === "sent" &&
                        ["open", "matched", "quoted"].includes(r.status) ? (
                          <span className="flex gap-2">
                            <button
                              onClick={() => accept(q.id)}
                              data-testid={`accept-${q.id}`}
                              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                            >
                              {t("accept")}
                            </button>
                            <button
                              onClick={() => decline(q.id)}
                              data-testid={`decline-${q.id}`}
                              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                            >
                              {t("decline")}
                            </button>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
      {rfqs ? <SavedSearchesList email={email} token={token} /> : null}
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
