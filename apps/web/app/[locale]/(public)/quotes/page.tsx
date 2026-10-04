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
  createdAt: string;
  updatedAt: string;
  operator: {
    name: string;
    verified: boolean;
    dealsClosed?: number;
    /** QA-451: avg buyer rating + count across this operator's deals. */
    ratingAvg?: number;
    ratingCount?: number;
    /** QA-449: post-close reach-back — only present on the accepted quote
     *  (the deal's closed; the buyer legitimately gets the contact). */
    contactEmail?: string;
    /** QA-472: the operator is suspended — the offer can't be accepted
     *  while it lasts (it revives on reinstate, it isn't voided). */
    unavailable?: boolean;
  } | null;
  /** QA-451: on accepted quotes — the deal id to rate + the rating given. */
  deal?: { id?: string; buyerRating?: number };
}
interface Rfq {
  id: string;
  status: string;
  concierge?: boolean;
  buyerEmail: string;
  createdAt: string;
  /** The request's own field map — echoed by the API for the repost
   *  handoff (QA-410); contact keys ride along for the form to reuse. */
  fields?: Record<string, unknown>;
  // Operators the request actually reached (delayed matches don't count).
  deliveredTo: number;
  /** QA-442: derived liveness deadline — when this request stops
   *  collecting offers (dated: day after dateTo; else createdAt+30d). */
  deadlineAt: string;
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

  // "Ending first" triage — same deadline sort the operator inbox has
  // (QA-448): soonest-dying live request first, terminal rows last.
  const [endingFirst, setEndingFirst] = useState(false);

  async function load(e?: React.FormEvent, tok?: string, ending = endingFirst) {
    e?.preventDefault();
    const tk = tok ?? token;
    // QA-474: no token doesn't short-circuit — a signed-in buyer's session
    // proves their mailbox server-side and the inbox loads anyway (401
    // below still maps to needLink for anonymous visitors).
    // Token rides a header, not the query string — bearer tokens in URLs
    // persist in server logs, history and Referer (QA-156).
    let res: Response;
    try {
      const qs = new URLSearchParams();
      // Empty `email=` would 400 the request — the session path needs the
      // param ABSENT so the server fills it from the cookie (QA-480).
      if (email) qs.set("email", email);
      if (ending) qs.set("sort", "deadline");
      res = await fetch(`/api/buyer/quotes?${qs.toString()}`, {
        headers: { "x-rfq-token": tk },
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    if (!res.ok) {
      const d = await readJsonOr<{ error?: string }>(res, {});
      setMsg(d.error ?? tc("error"));
      return;
    }
    const rows = await readJsonOr<Rfq[]>(res, []);
    setRfqs(rows);
    // Session path (QA-474): the server resolved the mailbox from the
    // session cookie — backfill the input so action bodies (accept etc.)
    // carry a real buyerEmail and the field shows who we're acting as.
    if (!email && rows[0]?.buyerEmail) setEmail(rows[0].buyerEmail);
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
    if (email) {
      void load(undefined, effective);
    } else {
      // QA-480: a signed-in buyer lands here with no email/token — their
      // session already proves the mailbox server-side (QA-474). Resolve
      // it once and auto-load; anonymous visitors get {user:null} and
      // keep the form untouched (no needLink flash on first paint).
      void fetch("/api/auth/me")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { user?: { email?: string | null } | null } | null) => {
          if (d?.user?.email) void load(undefined, effective);
        })
        .catch(() => {});
    }
    // mount-only: refresh via the search form; load re-creates per render
    // so it must not be a dep or the effect refetches every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // QA-451: once-ever 1-5 rating on the closed deal — updates the row
  // in place via the same re-fetch the accept/decline handlers use.
  async function rateDeal(dealId: string, rating: number) {
    let res: Response;
    try {
      res = await fetch(`/api/deals/${dealId}/rate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyerEmail: email, token, rating }),
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    if (!res.ok) {
      const d = await readJsonOr<{ error?: string }>(res, {});
      setMsg(d.error ?? tc("error"));
      return;
    }
    await load();
  }

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

  // QA-446: a dying request buys a week in place — quotes and the
  // delivered-to history survive, unlike the QA-410 repost twin.
  async function extendRfq(rfqId: string) {
    let res: Response;
    try {
      res = await fetch(`/api/rfqs/${rfqId}/extend`, {
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
    setMsg(t("extendedMsg"));
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
        <button
          type="button"
          onClick={() => {
            const v = !endingFirst;
            setEndingFirst(v);
            void load(undefined, undefined, v);
          }}
          data-testid="buyer-sort-ending"
          className={`rounded-md px-4 py-2 text-sm ${
            endingFirst
              ? "border border-border bg-surface font-medium text-foreground"
              : "border border-border bg-background text-muted"
          }`}
        >
          {t("sortEnding")}
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
                    {r.quotes.length > 0 ? (
                      <span className="text-xs text-muted" data-testid={`offer-count-${r.id}`}>
                        {t("offerCount", { count: r.quotes.length })}
                      </span>
                    ) : null}
                    {["open", "matched", "quoted"].includes(r.status) ? (
                      <span className="text-xs text-muted" data-testid={`rfq-deadline-${r.id}`}>
                        {t("closesOn", {
                          date: new Date(r.deadlineAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          }),
                        })}
                      </span>
                    ) : null}
                    {r.concierge ? (
                      <span className="rounded-md bg-surface px-2 py-0.5 text-xs font-medium text-success" data-testid={`concierge-badge-${r.id}`}>
                        {t("concierge.done")}
                      </span>
                    ) : null}
                    {["open", "matched", "quoted"].includes(r.status) ? (
                      <button
                        onClick={() => extendRfq(r.id)}
                        data-testid={`extend-rfq-${r.id}`}
                        className="rounded-md border border-border bg-background px-2 py-0.5 text-xs"
                      >
                        {t("extend")}
                      </button>
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
                    {/* QA-410 repost: a dead request on a still-live listing
                        offers "Request again" — the field map hands off via
                        sessionStorage (same-tab only; a new tab degrades to a
                        blank form, never a data leak). */}
                    {!["open", "matched", "quoted"].includes(r.status) &&
                    r.listing?.browseable ? (
                      <a
                        href={`/rfq/${r.listing.id}`}
                        onClick={() => {
                          try {
                            sessionStorage.setItem(
                              `jm-rfq-repost:${r.listing!.id}`,
                              JSON.stringify(r.fields ?? {}),
                            );
                          } catch {
                            /* storage full/blocked — repost degrades to blank */
                          }
                        }}
                        className="text-xs underline underline-offset-4"
                        data-testid={`repost-rfq-${r.id}`}
                      >
                        {t("repost")}
                      </a>
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
                          </span>
                          {/* QA-414: cheapest live offer gets the badge — the
                              comparison the sort implies made explicit. */}
                          {q.status === "sent" &&
                          q.id ===
                            r.quotes.find((o) => o.status === "sent")?.id ? (
                            <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-foreground ring-1 ring-border" data-testid="best-price">
                              {t("bestPrice")}
                            </span>
                          ) : null}{" "}
                          {/* QA-445: a still-live quote touched since
                              creation was revised — flag it so the buyer
                              connects the "revised" email to this row. */}
                          {q.status === "sent" && q.updatedAt !== q.createdAt ? (
                            <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-foreground ring-1 ring-border" data-testid={`quote-updated-${q.id}`}>
                              {t("updated")}
                            </span>
                          ) : null}{" "}
                          <span className="text-sm text-muted">
                            {t("by", { name: q.operator?.name ?? "" })}
                            {q.operator?.verified ? ` (${tc("verified")})` : ` (${tc("unverified")})`} · {tc(`quoteState.${q.status}`)}
                            {(q.operator?.dealsClosed ?? 0) > 0
                              ? ` · ${t("dealsCount", { count: q.operator!.dealsClosed! })}`
                              : ""}
                            {(q.operator?.ratingCount ?? 0) > 0
                              ? ` · ${t("ratingAvg", { avg: q.operator!.ratingAvg!.toFixed(1), count: q.operator!.ratingCount! })}`
                              : ""}
                          </span>
                          {q.message ? <p className="mt-1 text-sm">{q.message}</p> : null}
                          {/* QA-451: once-ever 1-5 rating, in place. */}
                          {q.status === "accepted" && q.deal?.id ? (
                            <p className="mt-1 text-sm" data-testid={`rate-deal-${q.deal.id}`}>
                              {q.deal.buyerRating ? (
                                t("ratedMsg", { rating: q.deal.buyerRating })
                              ) : (
                                <>
                                  {t("ratePrompt")}{" "}
                                  {[1, 2, 3, 4, 5].map((n) => (
                                    <button
                                      key={n}
                                      type="button"
                                      onClick={() => rateDeal(q.deal!.id!, n)}
                                      data-testid={`rate-${q.deal!.id}-${n}`}
                                      className="mx-0.5 rounded border border-border bg-background px-1.5 py-0.5 text-xs hover:bg-surface"
                                    >
                                      {n}
                                    </button>
                                  ))}
                                </>
                              )}
                            </p>
                          ) : null}
                          {/* QA-449: accepted = deal closed — the buyer
                              needs a reach-back path on the page itself,
                              not just in the close mail. */}
                          {q.status === "accepted" && q.operator?.contactEmail ? (
                            <p className="mt-1 text-sm" data-testid={`quote-contact-${q.id}`}>
                              {t("reachOperator", { name: q.operator.name })}{" "}
                              <a
                                className="underline"
                                href={`mailto:${q.operator.contactEmail}`}
                              >
                                {q.operator.contactEmail}
                              </a>
                            </p>
                          ) : null}
                        </div>
                        {q.status === "sent" &&
                        ["open", "matched", "quoted"].includes(r.status) ? (
                          q.operator?.unavailable ? (
                            <span className="flex items-center gap-2">
                              {/* QA-472: don't offer an Accept that can
                                  only 409 — the suspended offer is dead
                                  while it lasts; Decline still clears it. */}
                              <span
                                className="text-xs text-muted"
                                data-testid={`unavailable-${q.id}`}
                              >
                                {t("operatorUnavailable")}
                              </span>
                              <button
                                onClick={() => decline(q.id)}
                                data-testid={`decline-${q.id}`}
                                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                              >
                                {t("decline")}
                              </button>
                            </span>
                          ) : (
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
                          )
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
