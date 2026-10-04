"use client";

import { ConciergeUpsell } from "@/components/concierge-upsell";
import { SavedSearchesList } from "@/components/saved-searches-list";
import { CONCIERGE_PRICE_USD } from "@jetmarket/config";
import { readJsonOr } from "@/lib/fetch-json";
import { errText } from "@/lib/error-catalog";
import { useSearchParams } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Suspense, useRef, useState } from "react";
import { formatMoney } from "@/lib/format";
import { QUOTE_DECLINE_REASONS } from "@/lib/repo/types";

interface Quote {
  id: string;
  amount: number;
  currency: string;
  message: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  operator: {
    /** QA-490: profile link target — /operators/<id>. */
    id?: string;
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
  /** QA-511: the buyer's live counter-offer (one per offer round — a
   *  revise clears it). */
  counterAmount?: number;
  counteredAt?: string;
  /** QA-522: resolved counter rounds — the negotiation trail (the live
   *  round rides `counterAmount` + the chip, not this list). */
  counterRounds?: {
    id: string;
    amount: number;
    currency: string;
    note?: string;
    outcome: "answered" | "withdrawn" | "declined" | "accepted" | "expired";
    createdAt: string;
    resolvedAt?: string;
  }[];
  /** QA-530: superseded terms from the operator's revises — the price
   *  ladder behind the current offer, newest first. */
  revisions?: {
    id: string;
    amount: number;
    currency: string;
    message?: string;
    supersededAt: string;
  }[];
  /** QA-531: this load is the buyer's first look at the CURRENT terms —
   *  buyer_seen_at was still null when the API read it (fresh offer, or
   *  revised since last view). Retires on the next load. */
  wasUnseen?: boolean;
}
interface Rfq {
  id: string;
  status: string;
  concierge?: boolean;
  buyerEmail: string;
  createdAt: string;
  /** QA-482: last content-write stamp — a quote whose own updatedAt is
   *  older predates the latest amendment (QA-485 stale-offer chip). */
  updatedAt: string;
  /** The request's own field map — echoed by the API for the repost
   *  handoff (QA-410); contact keys ride along for the form to reuse. */
  fields?: Record<string, unknown>;
  // Operators the request actually reached (delayed matches don't count).
  deliveredTo: number;
  /** QA-481: vertical field defs for the inline edit form — key/label/
   *  type/required built server-side (the client never imports config). */
  editFields?: {
    key: string;
    label: string;
    type: string;
    required: boolean;
    options?: { value: string; label: string }[];
  }[];
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
  const locale = useLocale();
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
  // QA-481: which live row's inline edit form is open (one at a time).
  const [editingId, setEditingId] = useState<string | null>(null);
  // QA-508: which quote's decline-reason picker is open — declining is a
  // two-step so the buyer can say why (optional, structured).
  const [decliningId, setDecliningId] = useState<string | null>(null);
  // QA-511: which quote's counter-offer input is open + the draft amount.
  const [counteringId, setCounteringId] = useState<string | null>(null);
  const [counterDraft, setCounterDraft] = useState("");
  // QA-521: optional one-line note riding the counter.
  const [counterNote, setCounterNote] = useState("");
  // QA-529: which quote's report picker is open; the reported set swaps
  // the control for a "Reported" line (a re-flag would only 409).
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState("off_platform");
  const [reportNote, setReportNote] = useState("");
  const [reportedIds, setReportedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // QA-486: one in-flight mutation at a time. Every action below raced a
  // double-click before — accept/close/extend 409'd harmlessly, but a
  // second PATCH succeeded and re-mailed every delivered operator. The ref
  // is the real gate (state lags a render — a same-tick double-click reads
  // a stale `busy`); the state just feeds `disabled` for affordance.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  async function withBusy(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

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
      // no-store: the focus-refresh polls this URL and a heuristically
      // cached copy would keep the inbox stale anyway (QA-491).
      res = await fetch(`/api/buyer/quotes?${qs.toString()}`, {
        headers: { "x-rfq-token": tk },
        cache: "no-store",
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    if (!res.ok) {
      const d = await readJsonOr<{ error?: string; code?: string }>(res, {});
      setMsg(errText(d, tc("error")));
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
    const resend = () =>
    withBusy(() => resendImpl());

  async function resendImpl() {
    if (!email) {
      setMsg(t("needEmail"));
      return;
    }
    let res: Response;
    try {
      res = await fetch("/api/buyer/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, locale }),
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    const d = await readJsonOr<{ error?: string; code?: string }>(res, {});
    setMsg(res.ok ? t("resendSent") : (errText(d, tc("error"))));
  }

  // Auto-load when arriving with ?email= (magic-link/thank-you redirect),
  // then drop any bearer token (query `t` or `#t=` fragment) from the
  // address bar so it doesn't sit in history. The token moves to
  // sessionStorage instead (QA-482 fix): replaceState strips the URL but a
  // guest buyer has no session — a bare reload used to 401 their inbox
  // away. Same-tab storage only; a fresh tab still needs the mailed link.
  useEffect(() => {
    let stored = "";
    try {
      stored = sessionStorage.getItem("jm-quotes-token") ?? "";
    } catch {
      /* storage blocked — token still works from the URL below */
    }
    const hashToken = new URLSearchParams(window.location.hash.slice(1)).get(
      "t",
    );
    const effective = token || hashToken || stored || "";
    if (hashToken && !token) setToken(hashToken);
    else if (!token && !hashToken && stored) setToken(stored);
    // Freshly-arrived token (either carrier) overwrites the stash — a
    // different buyer's link in the same tab must not keep the old one.
    if (hashToken || params.get("t")) {
      try {
        sessionStorage.setItem("jm-quotes-token", effective);
      } catch {
        /* storage blocked — reload loses the token again, same as before */
      }
    }
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

  // QA-491: a parked buyer shouldn't have to reload for new offers — the
  // inbox quietly refetches when the tab wakes. Both signals are hooked:
  // tab-return fires visibilitychange (hidden→visible) BEFORE focus, and
  // some window-focus paths only emit focus. Refs mirror the latest
  // render so the mount-only listener never goes stale. Skips while:
  // nothing has loaded yet (the email form owns the screen), a mutation
  // is in flight (rows would churn under a pending accept), the amend
  // form is open, or the tab isn't the visible one. 10s throttle so
  // tab-juggling can't hammer the API.
  const loadRef = useRef(load);
  const editingRef = useRef(editingId);
  const rowsRef = useRef(rfqs);
  const lastAuto = useRef(0);
  loadRef.current = load;
  editingRef.current = editingId;
  rowsRef.current = rfqs;
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState !== "visible") return;
      if (busyRef.current || editingRef.current !== null) return;
      if (rowsRef.current === null) return;
      const now = Date.now();
      if (now - lastAuto.current < 10_000) return;
      lastAuto.current = now;
      void loadRef.current();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, []);

  // QA-451: once-ever 1-5 rating on the closed deal — updates the row
  // in place via the same re-fetch the accept/decline handlers use.
    const rateDeal = (dealId: string, rating: number) =>
    withBusy(() => rateDealImpl(dealId, rating));

  async function rateDealImpl(dealId: string, rating: number) {
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
      const d = await readJsonOr<{ error?: string; code?: string }>(res, {});
      setMsg(errText(d, tc("error")));
      return;
    }
    await load();
  }

    const accept = (quoteId: string) =>
    withBusy(() => acceptImpl(quoteId));

  async function acceptImpl(quoteId: string) {
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
    const data = await readJsonOr<{ error?: string; code?: string; deal?: { id: string } }>(res, {});
    if (!res.ok || !data.deal) {
      setMsg(errText(data, tc("error")));
      return;
    }
    setMsg(t("accepted", { id: data.deal.id }));
    await load();
  }

    const decline = (quoteId: string, reason?: string) =>
    withBusy(() => declineImpl(quoteId, reason));

  async function declineImpl(quoteId: string, reason?: string) {
    let res: Response;
    try {
      res = await fetch(`/api/quotes/${quoteId}/decline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          buyerEmail: email,
          token,
          ...(reason ? { reason } : {}),
        }),
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    const data = await readJsonOr<{ error?: string; code?: string }>(res, {});
    if (!res.ok) {
      setMsg(errText(data, tc("error")));
      return;
    }
    setMsg(t("declinedMsg"));
    setDecliningId(null);
    await load();
  }

  // QA-511: counter-offer — the buyer names their price instead of
  // declining outright; the quote stays live and the operator answers
  // by revising (which clears the counter for the next round).
  const counter = (quoteId: string) =>
    withBusy(() => counterImpl(quoteId));

  async function counterImpl(quoteId: string) {
    const amount = Math.round(Number(counterDraft));
    let res: Response;
    try {
      res = await fetch(`/api/quotes/${quoteId}/counter`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          buyerEmail: email,
          token,
          amount,
          ...(counterNote.trim() ? { note: counterNote.trim() } : {}),
        }),
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    const data = await readJsonOr<{ error?: string; code?: string }>(res, {});
    if (!res.ok) {
      setMsg(errText(data, tc("error")));
      return;
    }
    setCounteringId(null);
    setCounterNote("");
    setMsg(t("counteredMsg"));
    await load();
  }

  // QA-529: flag a received quote for admin review — the demand-side
  // surface that was missing ("call me at…" fee circumvention, scam,
  // abuse). Same mailbox proof as every other buyer action; a dedupe
  // 409 still lands the "Reported" state since the flag exists either way.
  const report = (quoteId: string) =>
    withBusy(() => reportImpl(quoteId));

  async function reportImpl(quoteId: string) {
    let res: Response;
    try {
      res = await fetch(`/api/quotes/${quoteId}/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          buyerEmail: email,
          token,
          reason: reportReason,
          ...(reportNote.trim() ? { note: reportNote.trim() } : {}),
        }),
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    const data = await readJsonOr<{ error?: string; code?: string }>(res, {});
    if (!res.ok && res.status !== 409) {
      setMsg(errText(data, tc("error")));
      return;
    }
    setReportedIds((prev) => new Set(prev).add(quoteId));
    setReportingId(null);
    setReportNote("");
    setMsg(t("reportedMsg"));
  }

  const QUOTE_REPORT_REASONS = [
    "off_platform",
    "scam",
    "spam",
    "abusive",
    "other",
  ] as const;

  function reportControls(q: Quote) {
    if (reportedIds.has(q.id)) {
      return (
        <span
          className="text-xs text-muted"
          data-testid={`reported-${q.id}`}
        >
          {t("reportedDone")}
        </span>
      );
    }
    if (reportingId === q.id) {
      return (
        <span
          className="flex flex-wrap items-center gap-1"
          data-testid={`report-picker-${q.id}`}
        >
          <span className="text-xs text-muted">{t("reportTitle")}</span>
          {QUOTE_REPORT_REASONS.map((r) => (
            <button
              key={r}
              onClick={() => setReportReason(r)}
              disabled={busy}
              data-testid={`report-reason-${r}-${q.id}`}
              className={`rounded-md border px-2 py-1 text-xs ${
                reportReason === r
                  ? "border-primary bg-surface font-medium"
                  : "border-border bg-background"
              }`}
            >
              {t(`reportReason.${r}`)}
            </button>
          ))}
          <input
            value={reportNote}
            onChange={(e) => setReportNote(e.target.value)}
            maxLength={500}
            placeholder={t("reportNotePlaceholder")}
            aria-label={t("reportNotePlaceholder")}
            data-testid={`report-note-${q.id}`}
            className="w-40 rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
          <button
            onClick={() => report(q.id)}
            disabled={busy}
            data-testid={`report-send-${q.id}`}
            className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {t("reportSend")}
          </button>
          <button
            onClick={() => setReportingId(null)}
            data-testid={`report-cancel-${q.id}`}
            className="text-xs text-muted underline"
          >
            {t("cancelEdit")}
          </button>
        </span>
      );
    }
    return (
      <button
        onClick={() => {
          setReportingId(q.id);
          setReportReason("off_platform");
        }}
        disabled={busy}
        data-testid={`report-${q.id}`}
        className="text-xs text-muted underline"
      >
        {t("report")}
      </button>
    );
  }

  // QA-518: pull a live counter off the table — the cleared round lets
  // the buyer counter again (the op gets a short mail so they stop
  // answering a number that's gone).
  const withdrawCounter = (quoteId: string) =>
    withBusy(() => withdrawCounterImpl(quoteId));

  async function withdrawCounterImpl(quoteId: string) {
    let res: Response;
    try {
      res = await fetch(`/api/quotes/${quoteId}/counter`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyerEmail: email, token }),
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    const data = await readJsonOr<{ error?: string; code?: string }>(res, {});
    if (!res.ok) {
      setMsg(errText(data, tc("error")));
      return;
    }
    setMsg(t("counterWithdrawnMsg"));
    await load();
  }

  // Two-step like the decline picker: the button reveals an inline
  // amount field (prefilled just under the ask); a live counter
  // suppresses the button — one counter per offer round.
  function counterControls(q: Quote) {
    if (q.counterAmount != null) return null;
    if (counteringId === q.id) {
      return (
        <span
          className="flex flex-wrap items-center gap-1"
          data-testid={`counter-picker-${q.id}`}
        >
          <input
            type="number"
            min={1}
            step={1}
            value={counterDraft}
            onChange={(e) => setCounterDraft(e.target.value)}
            aria-label={t("counterYourPrice")}
            data-testid={`counter-amount-${q.id}`}
            className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
          <span className="text-xs text-muted">{q.currency}</span>
          {/* QA-521: context for the number — "covers repositioning".
              One line, optional; the operator sees it in the inbox
              and the counter mail. */}
          <input
            type="text"
            maxLength={500}
            value={counterNote}
            onChange={(e) => setCounterNote(e.target.value)}
            placeholder={t("counterNotePlaceholder")}
            aria-label={t("counterNotePlaceholder")}
            data-testid={`counter-note-${q.id}`}
            className="w-56 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
          <button
            onClick={() => counter(q.id)}
            disabled={busy || !(Number(counterDraft) > 0)}
            data-testid={`counter-send-${q.id}`}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            {t("counterSend")}
          </button>
          <button
            onClick={() => setCounteringId(null)}
            data-testid={`counter-cancel-${q.id}`}
            className="text-xs text-muted underline"
          >
            {t("cancelEdit")}
          </button>
        </span>
      );
    }
    return (
      <button
        onClick={() => {
          setCounterDraft(String(Math.max(1, q.amount - 1)));
          setCounterNote("");
          setCounteringId(q.id);
        }}
        disabled={busy}
        data-testid={`counter-${q.id}`}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
      >
        {t("counter")}
      </button>
    );
  }

  // QA-508: two-step decline — the button reveals structured reason chips;
  // picking one POSTs with it, "without a reason" POSTs bare.
  function declineControls(q: Quote) {
    if (decliningId === q.id) {
      return (
        <span
          className="flex flex-wrap items-center gap-1"
          data-testid={`decline-picker-${q.id}`}
        >
          <span className="text-xs text-muted">
            {t("declineReasonsTitle")}
          </span>
          {QUOTE_DECLINE_REASONS.map((r) => (
            <button
              key={r}
              onClick={() => decline(q.id, r)}
              disabled={busy}
              data-testid={`decline-reason-${r}-${q.id}`}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
            >
              {t(`declineReason.${r}`)}
            </button>
          ))}
          <button
            onClick={() => decline(q.id)}
            disabled={busy}
            data-testid={`decline-no-reason-${q.id}`}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            {t("declineNoReason")}
          </button>
          <button
            onClick={() => setDecliningId(null)}
            data-testid={`decline-cancel-${q.id}`}
            className="text-xs text-muted underline"
          >
            {t("cancelEdit")}
          </button>
        </span>
      );
    }
    return (
      <button
        onClick={() => setDecliningId(q.id)}
        disabled={busy}
        data-testid={`decline-${q.id}`}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
      >
        {t("decline")}
      </button>
    );
  }

    const closeRfq = (rfqId: string) =>
    withBusy(() => closeRfqImpl(rfqId));

  async function closeRfqImpl(rfqId: string) {
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
    const data = await readJsonOr<{ error?: string; code?: string }>(res, {});
    if (!res.ok) {
      setMsg(errText(data, tc("error")));
      return;
    }
    setMsg(t("closedMsg"));
    await load();
  }

  // QA-446: a dying request buys a week in place — quotes and the
  // delivered-to history survive, unlike the QA-410 repost twin.
    const extendRfq = (rfqId: string) =>
    withBusy(() => extendRfqImpl(rfqId));

  async function extendRfqImpl(rfqId: string) {
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
    const data = await readJsonOr<{ error?: string; code?: string }>(res, {});
    if (!res.ok) {
      setMsg(errText(data, tc("error")));
      return;
    }
    setMsg(t("extendedMsg"));
    await load();
  }

  // QA-481: amend a live request in place — quotes and delivered-to
  // history survive; the PATCH CAS keeps it off terminal rows, the route
  // re-fans-out to newly-fitting operators and mails the rest.
    const amendRfq = (rfqId: string, fields: Record<string, unknown>) =>
    withBusy(() => amendRfqImpl(rfqId, fields));

  async function amendRfqImpl(rfqId: string, fields: Record<string, unknown>) {
    let res: Response;
    try {
      res = await fetch(`/api/rfqs/${rfqId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyerEmail: email, token, fields }),
      });
    } catch {
      setMsg(tc("error"));
      return;
    }
    const data = await readJsonOr<{ error?: string; code?: string }>(res, {});
    if (!res.ok) {
      setMsg(errText(data, tc("error")));
      return;
    }
    setEditingId(null);
    setMsg(t("amendedMsg"));
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
          disabled={busy}
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
                          date: new Date(r.deadlineAt).toLocaleDateString(locale, {
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
                    {/* QA-487: the route 409s extends with ≥8d of horizon
                        left — hide the button while the click would only
                        error. It reappears inside the extendable window. */}
                    {["open", "matched", "quoted"].includes(r.status) &&
                    Date.parse(r.deadlineAt) <
                      Date.now() + 8 * 86_400_000 ? (
                      <button
                        onClick={() => extendRfq(r.id)}
                        disabled={busy}
                        data-testid={`extend-rfq-${r.id}`}
                        className="rounded-md border border-border bg-background px-2 py-0.5 text-xs"
                      >
                        {t("extend")}
                      </button>
                    ) : null}
                    {["open", "matched", "quoted"].includes(r.status) &&
                    r.editFields?.length ? (
                      <button
                        onClick={() =>
                          setEditingId(editingId === r.id ? null : r.id)
                        }
                        data-testid={`edit-rfq-${r.id}`}
                        className="rounded-md border border-border bg-background px-2 py-0.5 text-xs"
                      >
                        {t("edit")}
                      </button>
                    ) : null}
                    {["open", "matched", "quoted"].includes(r.status) ? (
                      <button
                        onClick={() => closeRfq(r.id)}
                        disabled={busy}
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
                {editingId === r.id && r.editFields?.length ? (
                  <RfqEditForm
                    rfq={r}
                    onSave={(fields) => amendRfq(r.id, fields)}
                    onCancel={() => setEditingId(null)}
                    disabled={busy}
                    saveLabel={t("saveEdit")}
                    cancelLabel={t("cancelEdit")}
                  />
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
                            {formatMoney(q.amount, q.currency, locale)}
                          </span>
                          {/* QA-531: the inbox GET stamps seen-at AFTER
                              reading — wasUnseen marks exactly the rows
                              this load is the buyer's first look at
                              (fresh offer, or revised since last visit).
                              Filled chip so it pops over the outline
                              badges; retires on the next load. */}
                          {q.wasUnseen ? (
                            <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground" data-testid={`quote-new-${q.id}`}>
                              {t("newOffer")}
                            </span>
                          ) : null}
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
                          {/* QA-485: the request was amended AFTER this
                              offer's last touch — the operator was mailed
                              the diff but the buyer needs the same signal
                              when comparing. Clears when they revise. */}
                          {q.status === "sent" && r.updatedAt > q.updatedAt ? (
                            <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-warning ring-1 ring-border" data-testid={`quote-stale-${q.id}`}>
                              {t("staleOffer")}
                            </span>
                          ) : null}{" "}
                          {/* QA-511: your counter is on the table — the
                              operator was mailed; a revise clears it. */}
                          {q.status === "sent" && q.counterAmount != null ? (
                            <>
                              <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-foreground ring-1 ring-border" data-testid={`counter-sent-${q.id}`}>
                                {t("counteredYou", {
                                  amount: formatMoney(q.counterAmount, q.currency, locale),
                                })}
                              </span>{" "}
                              {/* QA-518: a counter is retractable while it
                                  still waits — the op's answer window. */}
                              <button
                                onClick={() => withdrawCounter(q.id)}
                                disabled={busy}
                                data-testid={`counter-withdraw-${q.id}`}
                                className="text-xs text-muted underline"
                              >
                                {t("counterWithdraw")}
                              </button>
                            </>
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
                            {/* QA-490: trust-check path — the card showed
                                name + stats but the public profile with
                                fleet/response-time sat unreachable.
                                Suspended operators' profiles 404, so the
                                link drops to plain text then. Testid
                                deliberately NOT quote-*: descendant
                                [data-testid^="quote-"] locators would
                                count it as a second card (demo-inbox). */}
                            {q.operator?.id && !q.operator.unavailable ? (
                              <>
                                {" "}
                                <Link
                                  href={`/operators/${q.operator.id}`}
                                  className="text-primary underline"
                                  data-testid={`op-profile-${q.id}`}
                                >
                                  {t("viewProfile")}
                                </Link>
                              </>
                            ) : null}
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
                                      disabled={busy}
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
                          {/* QA-522: negotiation trail — what became of
                              each counter (the live one chips above).
                              Newest first, API-ordered. */}
                          {(q.counterRounds?.length ?? 0) > 0 ? (
                            <div
                              className="mt-1"
                              data-testid={`counterrounds-${q.id}`}
                            >
                              <span className="text-xs font-medium text-muted">
                                {t("counterHistory")}
                              </span>
                              <ul className="mt-0.5 space-y-0.5">
                                {q.counterRounds!.map((r) => (
                                  <li
                                    key={r.id}
                                    className="text-xs text-muted"
                                    data-testid={`counterround-${r.id}`}
                                  >
                                    {t("counterRoundLine", {
                                      amount: formatMoney(
                                        r.amount,
                                        r.currency,
                                        locale,
                                      ),
                                      outcome: t(
                                        `counterOutcome.${r.outcome}`,
                                      ),
                                    })}
                                    {r.note ? ` — “${r.note}”` : ""}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {/* QA-530: operator revise history — what the
                              offer USED to say, newest first. The card's
                              top price is current; these are the rungs
                              below it ("was X → now Y" — the drop is the
                              close-signal the revise mail hinted at). */}
                          {(q.revisions?.length ?? 0) > 0 ? (
                            <div
                              className="mt-1"
                              data-testid={`quotehistory-${q.id}`}
                            >
                              <ul className="mt-0.5 space-y-0.5">
                                {q.revisions!.map((rev) => (
                                  <li
                                    key={rev.id}
                                    className="text-xs text-muted"
                                    data-testid={`quoterev-${rev.id}`}
                                  >
                                    {t("reviseLine", {
                                      amount: formatMoney(
                                        rev.amount,
                                        rev.currency,
                                        locale,
                                      ),
                                      date: new Date(
                                        rev.supersededAt,
                                      ).toLocaleDateString(locale, {
                                        month: "short",
                                        day: "numeric",
                                      }),
                                    })}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {/* QA-529: report this offer — the admin queue
                              surface for fee-circumvention/abuse; stays
                              available on terminal quotes too. */}
                          <div className="mt-1">{reportControls(q)}</div>
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
                              {declineControls(q)}
                            </span>
                          ) : (
                          <span className="flex flex-wrap gap-2">
                            <button
                              onClick={() => accept(q.id)}
                              disabled={busy}
                              data-testid={`accept-${q.id}`}
                              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                            >
                              {t("accept")}
                            </button>
                            {counterControls(q)}
                            {declineControls(q)}
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

/** QA-481: inline amend form for a live request — renders the vertical's
 *  field defs (delivered as `editFields` by the API) prefilled from the
 *  request's stored `fields`. Full replace semantics: whatever ships in
 *  the form is the new request body. */
function RfqEditForm({
  rfq,
  onSave,
  onCancel,
  saveLabel,
  cancelLabel,
  disabled,
}: {
  rfq: Rfq;
  onSave: (fields: Record<string, unknown>) => void;
  onCancel: () => void;
  saveLabel: string;
  cancelLabel: string;
  disabled?: boolean;
}) {
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of rfq.editFields ?? []) {
      const v = rfq.fields?.[f.key];
      init[f.key] = v === undefined || v === null ? "" : String(v);
    }
    return init;
  });
  return (
    <form
      className="mt-2 grid grid-cols-1 gap-2 rounded-md bg-surface p-3 sm:grid-cols-2"
      data-testid={`rfq-edit-form-${rfq.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        const fields: Record<string, unknown> = {};
        for (const f of rfq.editFields ?? []) {
          const v = vals[f.key] ?? "";
          if (v === "") {
            fields[f.key] = "";
          } else if (f.type === "number") {
            fields[f.key] = Number(v);
          } else {
            fields[f.key] = v;
          }
        }
        onSave(fields);
      }}
    >
      {(rfq.editFields ?? []).map((f) =>
        f.type === "textarea" ? (
          <label key={f.key} className="col-span-full text-xs text-muted">
            {f.label}
            <textarea
              value={vals[f.key] ?? ""}
              required={f.required}
              onChange={(e) =>
                setVals((v) => ({ ...v, [f.key]: e.target.value }))
              }
              className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              data-testid={`rfq-edit-${rfq.id}-${f.key}`}
            />
          </label>
        ) : f.type === "select" && f.options?.length ? (
          <label key={f.key} className="text-xs text-muted">
            {f.label}
            <select
              value={vals[f.key] ?? ""}
              required={f.required}
              onChange={(e) =>
                setVals((v) => ({ ...v, [f.key]: e.target.value }))
              }
              className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              data-testid={`rfq-edit-${rfq.id}-${f.key}`}
            >
              <option value="">—</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label key={f.key} className="text-xs text-muted">
            {f.label}
            <input
              type={
                f.type === "number"
                  ? "number"
                  : f.type === "date"
                    ? "date"
                    : f.type === "email"
                      ? "email"
                      : f.type === "tel"
                        ? "tel"
                        : "text"
              }
              value={vals[f.key] ?? ""}
              required={f.required}
              onChange={(e) =>
                setVals((v) => ({ ...v, [f.key]: e.target.value }))
              }
              className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              data-testid={`rfq-edit-${rfq.id}-${f.key}`}
            />
          </label>
        ),
      )}
      <div className="col-span-full flex gap-2">
        <button
          type="submit"
          disabled={disabled}
          className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
          data-testid={`rfq-edit-save-${rfq.id}`}
        >
          {saveLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border bg-background px-3 py-1 text-sm"
        >
          {cancelLabel}
        </button>
      </div>
    </form>
  );
}
