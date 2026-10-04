import type { EmailProvider } from "@jetmarket/providers/email";
import { brandedEmailHtml } from "@jetmarket/providers/email";
import type { AnalyticsProvider } from "@jetmarket/providers/analytics";
import { site } from "@jetmarket/config";
import {
  deliverAt,
  fromMinorUnits,
  matchOperators,
  type Currency,
  type Plan,
} from "@jetmarket/domain";
import type { Sql } from "postgres";
import type { MatchingConfig } from "@jetmarket/verticals";
import { enqueueJob, type ExpireResultDetailed } from "@jetmarket/db";
import {
  defaultLocale,
  getMessages,
  localePath,
  mailCopy,
  mailT,
} from "@jetmarket/i18n";
import { getVertical, rfqFieldLabels } from "@jetmarket/verticals";
import { logWarn } from "./log";
import type { WorkerRepo } from "./repo";

// QA-494: RFQ fan-out mails render in each recipient's users.locale —
// deps.fieldLabels is the en map built once in index.ts; other locales get
// the same label set resolved from their catalog's vertical subtree.
const workerLabelCache = new Map<string, ReadonlyMap<string, string>>();
async function workerFieldLabels(
  deps: WorkerDeps,
  locale: string,
): Promise<ReadonlyMap<string, string> | undefined> {
  // The default locale uses deps.fieldLabels directly — index.ts already
  // resolves the same subtree at boot, and tests inject label maps there.
  if (!locale || locale === defaultLocale) return deps.fieldLabels;
  let hit = workerLabelCache.get(locale);
  if (!hit) {
    const dict = (await getMessages(locale)) as Record<string, unknown>;
    const ns = ((dict.vertical ?? {}) as Record<string, unknown>)[
      deps.vertical
    ];
    hit =
      ns && typeof ns === "object"
        ? rfqFieldLabels(
            getVertical(deps.vertical as Parameters<typeof getVertical>[0]),
            ns as Record<string, unknown>,
          )
        : (deps.fieldLabels ?? new Map());
    workerLabelCache.set(locale, hit);
  }
  return hit;
}

export interface WorkerDeps {
  repo: WorkerRepo;
  sql: Sql;
  /** This deploy's vertical — sweeps + job claims are scoped to it so a
   * shared DB's other-vertical rows stay untouched (QA-295). */
  vertical: string;
  email: EmailProvider;
  plans: Plan[];
  /** Active vertical's fan-out matching shape (QA-229). */
  matching?: MatchingConfig;
  /** RFQ field key -> label, in the vertical's rfqFields order — emails show
   * these instead of raw keys (QA-234). */
  fieldLabels?: ReadonlyMap<string, string>;
  /** Config-derived contact keys (email/tel types + groupKey:"contact") —
   * detail lines mask these so a renamed contact field can't leak into
   * operator mail (QA-308). Defaults to name/email/phone when unset. */
  contactKeys?: ReadonlySet<string>;
  analytics?: AnalyticsProvider;
  now?: () => Date;
  /** Vertical's dated-inventory expiry shape (QA-418) — machinery has
   *  none, so the listing-expiry sweep no-ops there. */
  expiry?: { type: string; attributeKey: string };
  /** Hours of quote silence before the buyer nudge (QA-422); defaults to
   *  48, <=0 disables the sweep. */
  quoteNudgeHours?: number;
  /** QA-423 zero-quote nudge window in hours (defaults to 24, <=0 disables):
   *  how long a live RFQ may sit with zero live quotes before the buyer gets
   *  one "still gathering quotes" mail. Machinery picks its own window. */
  unquotedNudgeHours?: number;
  /** QA-425 unanswered-demand digest: RFQs older than this many hours in an
   *  operator's inbox with no live quote trigger a "N requests are waiting"
   *  digest (defaults 72, <=0 disables). Re-mails at most once per 7 days
   *  via the unanswered_mailed_at stamp — operators get a periodic pull,
   *  not a drip feed. */
  unansweredNudgeHours?: number;
  /** QA-477 empty-book nudge: an operator still without a single
   *  in-vertical listing this many hours after signup gets one "create
   *  your first listing" mail (defaults 48, <=0 disables). Once-ever via
   *  the empty_book_mailed_at stamp — no re-arms. */
  emptyBookNudgeHours?: number;
  /** QA-429 overdue-invoice chase: deals stuck 'invoiced' this many hours
   *  mail the operator a payment reminder (defaults 72, <=0 disables).
   *  Re-mails at most once per 7 days via the invoice_reminded_at stamp. */
  invoiceReminderHours?: number;
  /** QA-447 closing-soon nudge: a live RFQ whose liveness horizon lands
   *  within this many hours mails the buyer once — accept or extend
   *  (defaults 72, <=0 disables). Once-ever per RFQ via the
   *  closing_mailed_at stamp. */
  closingSoonHours?: number;
  /** QA-456 unrated-deal nudge: a deal closed this many hours ago whose
   *  buyer still hasn't rated mails them once — the close-mail rate link
   *  converts most buyers but the rest need one ask (defaults 72, <=0
   *  disables). Once-ever per deal via the rating_mailed_at stamp. */
  unratedNudgeHours?: number;
}

function at(deps: WorkerDeps): Date {
  return deps.now?.() ?? new Date();
}

/**
 * `rfq.fanout` { rfqId }: match the RFQ against operator fleets via domain
 * matchOperators, write rfq_matches (pending now / delayed w/ deliver_at),
 * mark the rfq matched, and enqueue quote-notification emails for pending
 * matches. Delayed ones are flipped by the poll-loop sweep.
 */
export async function rfqFanout(
  deps: WorkerDeps,
  payload: unknown,
): Promise<void> {
  const rfqId = (payload as { rfqId?: unknown })?.rfqId;
  if (typeof rfqId !== "string" || !rfqId) {
    throw new Error("rfq.fanout payload requires rfqId: string");
  }
  const rfq = await deps.repo.loadRfq(rfqId);
  if (!rfq) throw new Error(`rfq ${rfqId} not found`);
  // Fan-out only runs for LIVE RFQs: closed/expired/spam must not
  // re-notify operators for a dead request. `matched`/`quoted` are
  // admitted too — the amend path (QA-481) re-enqueues fan-out after a
  // buyer edits their request; insertMatches dedupes the existing pairs
  // so only newly-fitting operators get a row + mail, and markRfqMatched
  // is a no-op off `new` (the status never regresses).
  if (rfq.status !== "new" && rfq.status !== "matched" && rfq.status !== "quoted")
    return;

  const now = at(deps);
  const candidates = await deps.repo.loadOperatorCandidates(
    rfq.vertical,
    deps.matching,
  );
  // The RFQ form may not ask for a category — an RFQ on a lathe listing wants
  // lathe dealers. Infer it from the listing's category attribute; an
  // explicit RFQ field wins (QA-229).
  const reqFields = { ...rfq.fields };
  const catAttr = deps.matching?.categoryAttribute;
  if (catAttr && reqFields[catAttr] === undefined) {
    const v = rfq.listingAttributes?.[catAttr];
    if (typeof v === "string" && v) reqFields[catAttr] = v;
  }
  const matches = matchOperators(reqFields, candidates, deps.plans, {
    limit: 10,
    // The listing owner is notified directly by the web route — a self-match
    // would double-notify and let them quote their own RFQ.
    ...(rfq.ownerOperatorId
      ? { excludeOperatorIds: new Set([rfq.ownerOperatorId]) }
      : {}),
    ...(deps.matching?.rfqCategoryKeys
      ? { categoryKeys: deps.matching.rfqCategoryKeys }
      : {}),
    ...(deps.matching?.rfqSeatsKeys
      ? { seatsKeys: deps.matching.rfqSeatsKeys }
      : {}),
  });

  // A concierge RFQ was already paid for instant delivery — every match
  // goes out now, free/unverified included (QA-399). The buyer can pay in
  // the window between POST /api/rfqs and this job's claim; the flag on the
  // row is the thing that makes "instant" true at fan-out time.
  const instant = rfq.concierge;
  const inserted = await deps.repo.insertMatches(
    matches.map((m) => ({
      rfqId: rfq.id,
      operatorId: m.operatorId,
      listingId: m.listingId,
      state: instant || m.delivery === "instant" ? "pending" : "delayed",
      deliverAt:
        instant || m.delivery === "instant" ? now : deliverAt(m, now),
    })),
  );
  await deps.repo.markRfqMatched(rfq.id);
  // Instant matches notify now; delayed ones notify via the sweep.
  for (const m of inserted) {
    if (m.state === "pending") {
      await enqueueJob(deps.sql, "email.quote_notification", { matchId: m.id }, {
        vertical: deps.vertical,
      });
    }
  }
}

/** Search-alert digest cadence must mirror the web-side cooldown —
 * pending_ids only ever accumulates inside that window (QA-403). */
export const SEARCH_ALERT_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/**
 * Saved-search digest flush (QA-403): matches landing inside an alert's
 * cooldown queue onto `pending_ids`; once the window matures this sweep
 * mails ONE digest (not one mail per activation) and clears the queue.
 * Matching ran web-side at activation time — the worker only needs the
 * backlog + titles, never the facet filter.
 */
export async function searchAlertFlush(deps: WorkerDeps): Promise<number> {
  const matured = await deps.repo.alertBacklogs(
    deps.vertical,
    new Date(at(deps).getTime() - SEARCH_ALERT_COOLDOWN_MS),
  );
  let flushed = 0;
  const origin = `https://${site.domain}`;
  for (const alert of matured) {
    try {
      const rows = await deps.repo.loadDigestListings(
        alert.pendingIds,
        deps.vertical,
      );
      const live = rows.filter((r) => r.status === "active");
      // A fully-delisted backlog just clears — nothing worth mailing.
      if (!live.length) {
        await deps.repo.markSearchAlerted(alert.id);
        continue;
      }
      const unsub = `${origin}/api/search-alerts/unsubscribe?token=${encodeURIComponent(alert.token)}`;
      const first = live[0]!.title;
      // Watch rows (QA-407) link the watched listing and get update copy.
      const watchId =
        typeof alert.params["watch"] === "string" ? alert.params["watch"] : null;
      // QA-496: digest renders + deep-links in the alert's stamped locale.
      const m = await mailCopy(alert.locale);
      const targetUrl = watchId
        ? `${origin}${localePath(alert.locale, `/listing/${watchId}`)}`
        : (() => {
            const u = new URL(`${origin}/search`);
            for (const [k, v] of Object.entries(alert.params)) {
              for (const item of Array.isArray(v) ? v : [v]) {
                if (item !== undefined && item !== null)
                  u.searchParams.append(k, String(item));
              }
            }
            const rel = `${u.pathname}${u.search}`;
            return `${origin}${localePath(alert.locale, rel)}`;
          })();
      const subject = watchId
        ? mailT(m, "alertDigest.subjectWatch", { title: first })
        : live.length === 1
          ? mailT(m, "alertDigest.subjectOne", { title: first })
          : mailT(m, "alertDigest.subjectMany", { count: live.length });
      const intro = watchId
        ? mailT(m, "alertDigest.introWatch", { site: site.name })
        : mailT(
            m,
            live.length === 1
              ? "alertDigest.introOne"
              : "alertDigest.introMany",
            { site: site.name },
          );
      const lines = live.map((l) =>
        mailT(m, "alertDigest.line", {
          title: l.title,
          url: `${origin}${localePath(alert.locale, `/listing/${l.id}`)}`,
        }),
      );
      await deps.email.send({
        to: alert.email,
        subject,
        text: [
          intro,
          "",
          ...lines,
          "",
          `${watchId ? mailT(m, "alertConfirm.theListing") : mailT(m, "alertConfirm.yourSearch")}: ${targetUrl}`,
          `${mailT(m, "shared.unsubscribe")}: ${unsub}`,
        ].join("\n"),
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [intro, ...lines, `${mailT(m, "shared.unsubscribe")}: ${unsub}`],
          cta: {
            url: targetUrl,
            label: watchId
              ? mailT(m, "alertDigest.ctaWatch")
              : mailT(m, "alertDigest.cta"),
          },
        }),
      });
      await deps.repo.markSearchAlerted(alert.id);
      flushed += 1;
    } catch (e) {
      // One bad row must not stall the sweep — it stays queued and retries
      // next poll (mark is post-send so a send failure can't lose the backlog).
      logWarn("worker.search_alert_flush_failed", {
        alertId: alert.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return flushed;
}

/**
 * Delayed-match sweep — run each poll iteration (and standalone): flip due
 * `delayed` matches to `pending` and enqueue their notification jobs.
 */
export async function deliverDueMatches(deps: WorkerDeps): Promise<number> {
  const fresh = await deps.repo.deliverDueMatches(at(deps), deps.vertical);
  // Freshly-flipped matches have no job row yet, so they appear in the
  // stranded set too — Set dedupes; each match gets exactly one enqueue.
  // Stranded = pending with NO notification job row ever (crash between
  // flip and enqueue) — distinct from 'failed' jobs, which stay with
  // admin retry rather than being auto-resend in a loop (QA-162).
  const stranded = await deps.repo.unnotifiedPendingMatches(
    undefined,
    deps.vertical,
  );
  const ids = [...new Set([...fresh, ...stranded])];
  for (const matchId of ids) {
    await enqueueJob(deps.sql, "email.quote_notification", { matchId }, {
      vertical: deps.vertical,
    });
  }
  return ids.length;
}

/** A persisted RFQ waits this long before we decide its fan-out job was
 * never enqueued — shorter windows risk double-enqueue racing the web
 * route's own persist→enqueue (harmless anyway: the second run hits the
 * `new`-only status guard and early-returns). */
const FANOUT_GRACE_MS = 2 * 60_000;

/** Re-enqueue `rfq.fanout` for RFQs that persisted but never got a job —
 * the route's enqueue can throw post-write (QA-168). One level up from the
 * stranded-match sweep: no match rows exist yet at all. */
export async function recoverUnfanoutedRfqs(
  deps: WorkerDeps,
): Promise<number> {
  const ids = await deps.repo.unfanoutedRfqs(
    new Date(at(deps).getTime() - FANOUT_GRACE_MS),
    undefined,
    deps.vertical,
  );
  for (const rfqId of ids) {
    await enqueueJob(deps.sql, "rfq.fanout", { rfqId }, {
      vertical: deps.vertical,
    });
  }
  return ids.length;
}

/**
 * Expiry notifications — run right after the sweep. Buyers are unauthenticated
 * so email is the only channel; an operator whose quote was silently declined
 * by expiry learns why. Each send is fire-and-log: one bad address must not
 * stop the rest of the sweep's notifications.
 */
/**
 * Listing-expiry notifications (QA-418) — dated inventory (empty legs and
 * equivalents) silently drops out of browse when its date passes; until now
 * the operator only found out by noticing the "expired — hidden" chip. The
 * sweep claims each just-expired listing once (expiry_mailed_at CAS in the
 * same UPDATE) and mails a relist nudge: edit the date and it's live again.
 * Fire-and-log per row — one bad address never stalls the batch.
 */
export async function notifyExpiredListings(deps: WorkerDeps): Promise<number> {
  if (!deps.expiry) return 0;
  const rows = await deps.repo.sweepExpiredListings({
    vertical: deps.vertical,
    type: deps.expiry.type,
    attr: deps.expiry.attributeKey,
    now: at(deps),
  });
  for (const l of rows) {
    deps.analytics?.track({
      name: "listing_expired",
      props: { listingId: l.listingId },
    });
    try {
      const m = await mailCopy(l.locale);
      const subject = mailT(m, "listingExpired.subject", { title: l.title });
      const body = mailT(m, "listingExpired.body", {
        title: l.title,
        date: l.legDate,
        site: site.name,
      });
      await deps.email.send({
        to: l.operatorEmail,
        subject,
        text: body,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body],
        }),
      });
    } catch (e) {
      logWarn("worker.listing_expiry_email_failed", {
        listingId: l.listingId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return rows.length;
}

/**
 * Stale-quote buyer nudge (QA-422): quotes landed, the buyer went quiet —
 * one branded mail per RFQ deep-linking their /quotes inbox (the per-RFQ
 * bearer token in the fragment, per AGENTS). Claims once per RFQ via the
 * sweep's quote_nudge_mailed_at stamp; a fresh quote resets the window.
 */
export async function nudgeStaleQuotes(deps: WorkerDeps): Promise<number> {
  const hours = deps.quoteNudgeHours ?? 48;
  if (!(hours > 0)) return 0;
  const rows = await deps.repo.sweepStaleQuotes({
    vertical: deps.vertical,
    olderThan: new Date(at(deps).getTime() - hours * 3_600_000),
  });
  const origin = `https://${site.domain}`;
  for (const r of rows) {
    try {
      const quotesUrl = `${origin}${localePath(r.locale, "/quotes")}?email=${encodeURIComponent(
        r.buyerEmail,
      )}#t=${encodeURIComponent(r.accessToken)}`;
      // QA-493: the buyer reads the RFQ's stamped locale.
      const m = await mailCopy(r.locale);
      const forTitle = r.listingTitle
        ? mailT(m, "shared.forTitle", { title: r.listingTitle })
        : "";
      const subject = mailT(
        m,
        r.quoteCount === 1 ? "staleQuotes.subjectOne" : "staleQuotes.subjectMany",
        { count: r.quoteCount },
      );
      const body = mailT(
        m,
        r.quoteCount === 1 ? "staleQuotes.bodyOne" : "staleQuotes.bodyMany",
        { forTitle, site: site.name, count: r.quoteCount },
      );
      await deps.email.send({
        to: r.buyerEmail,
        subject,
        text: `${body}\n\n${mailT(m, "staleQuotes.label", { url: quotesUrl })}`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body],
          cta: { url: quotesUrl, label: mailT(m, "staleQuotes.cta") },
        }),
      });
      deps.analytics?.track({
        name: "quote_nudge_sent",
        props: { rfqId: r.rfqId, quotes: r.quoteCount },
      });
    } catch (e) {
      logWarn("worker.quote_nudge_failed", {
        rfqId: r.rfqId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return rows.length;
}

/**
 * QA-423: a live RFQ with zero live quotes past the nudge window leaves the
 * buyer completely dark since the submit confirmation — one branded mail
 * says operators were notified (or the listing owner was, for direct
 * requests) and deep-links their /quotes inbox so they can watch or close.
 * Claims once per RFQ via the sweep's no_quotes_mailed_at stamp.
 */
export async function nudgeUnquotedRfqs(deps: WorkerDeps): Promise<number> {
  const hours = deps.unquotedNudgeHours ?? 24;
  if (!(hours > 0)) return 0;
  const rows = await deps.repo.sweepUnquotedRfqs({
    vertical: deps.vertical,
    olderThan: new Date(at(deps).getTime() - hours * 3_600_000),
  });
  const origin = `https://${site.domain}`;
  for (const r of rows) {
    try {
      const quotesUrl = `${origin}${localePath(r.locale, "/quotes")}?email=${encodeURIComponent(
        r.buyerEmail,
      )}#t=${encodeURIComponent(r.accessToken)}`;
      const m = await mailCopy(r.locale);
      const subject = mailT(m, "noQuotes.subject");
      const forTitle = r.listingTitle
        ? mailT(m, "shared.forTitle", { title: r.listingTitle })
        : "";
      const reach =
        r.matchCount > 0
          ? mailT(
              m,
              r.matchCount === 1 ? "noQuotes.reachOne" : "noQuotes.reachMany",
              { count: r.matchCount },
            )
          : mailT(m, "noQuotes.reachOwner");
      const body = mailT(m, "noQuotes.body", {
        forTitle,
        site: site.name,
        reach,
      });
      await deps.email.send({
        to: r.buyerEmail,
        subject,
        text: `${body}\n\n${mailT(m, "noQuotes.label", { url: quotesUrl })}`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body],
          cta: { url: quotesUrl, label: mailT(m, "noQuotes.cta") },
        }),
      });
      deps.analytics?.track({
        name: "unquoted_nudge_sent",
        props: { rfqId: r.rfqId, matches: r.matchCount },
      });
    } catch (e) {
      logWarn("worker.unquoted_nudge_failed", {
        rfqId: r.rfqId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return rows.length;
}

/**
 * QA-447 closing-soon buyer nudge: a live request entering its liveness
 *  window (the QA-442 horizon, inside `closingSoonHours`) mails the buyer
 *  once — the mail names the close date, counts the live quotes still
 *  answerable, and offers the QA-446 week-extension so demand survives
 *  instead of silently expiring. Claims once per RFQ via the sweep's
 *  closing_mailed_at stamp; rows already past the horizon are the
 *  expired mail's job, not this one's.
 */
export async function nudgeClosingSoonRfqs(
  deps: WorkerDeps,
): Promise<number> {
  const hours = deps.closingSoonHours ?? 72;
  if (!(hours > 0)) return 0;
  const rows = await deps.repo.sweepClosingSoonRfqs({
    vertical: deps.vertical,
    dyingBefore: new Date(at(deps).getTime() + hours * 3_600_000),
  });
  const origin = `https://${site.domain}`;
  for (const r of rows) {
    try {
      const quotesUrl = `${origin}${localePath(r.locale, "/quotes")}?email=${encodeURIComponent(
        r.buyerEmail,
      )}#t=${encodeURIComponent(r.accessToken)}`;
      const m = await mailCopy(r.locale);
      const closes = new Date(`${r.closesOn}T00:00:00.000Z`)
        .toLocaleDateString(r.locale === "de" ? "de-DE" : "en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        });
      const subject = mailT(m, "closingSoon.subject", { date: closes });
      const forTitle = r.listingTitle
        ? mailT(m, "shared.forTitle", { title: r.listingTitle })
        : "";
      const quotesLine =
        r.quoteCount > 0
          ? mailT(
              m,
              r.quoteCount === 1
                ? "closingSoon.quotesOne"
                : "closingSoon.quotesMany",
              { count: r.quoteCount },
            )
          : mailT(m, "closingSoon.quotesNone");
      const body = mailT(m, "closingSoon.body", {
        forTitle,
        site: site.name,
        date: closes,
        quotes: quotesLine,
      });
      await deps.email.send({
        to: r.buyerEmail,
        subject,
        text: `${body}\n\n${mailT(m, "closingSoon.label", { url: quotesUrl })}`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body],
          cta: { url: quotesUrl, label: mailT(m, "closingSoon.cta") },
        }),
      });
      deps.analytics?.track({
        name: "closing_soon_nudge_sent",
        props: { rfqId: r.rfqId, quotes: r.quoteCount },
      });
    } catch (e) {
      logWarn("worker.closing_soon_nudge_failed", {
        rfqId: r.rfqId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return rows.length;
}

/**
 * QA-456 unrated-deal nudge: the deal-closed mail carries the rate link,
 *  but a buyer who skipped it leaves the operator's ★ record dark — one
 *  ask, once, after the deal has had time to actually happen. Claims via
 *  the sweep's rating_mailed_at stamp; a buyer who rated in the meantime
 *  drops out at the next claim (buyer_rating IS NULL is in the due set).
 */
export async function nudgeUnratedDeals(deps: WorkerDeps): Promise<number> {
  const hours = deps.unratedNudgeHours ?? 72;
  if (!(hours > 0)) return 0;
  const rows = await deps.repo.sweepUnratedDeals({
    vertical: deps.vertical,
    olderThan: new Date(at(deps).getTime() - hours * 3_600_000),
  });
  const origin = `https://${site.domain}`;
  for (const r of rows) {
    try {
      const rateUrl = `${origin}${localePath(r.locale, "/quotes")}?email=${encodeURIComponent(
        r.buyerEmail,
      )}#t=${encodeURIComponent(r.accessToken)}`;
      const m = await mailCopy(r.locale);
      const who = r.operatorName ?? mailT(m, "shared.theOperator");
      const subject = mailT(m, "unratedDeal.subject", { who });
      const onTitle = r.listingTitle
        ? mailT(m, "shared.onTitle", { title: r.listingTitle })
        : "";
      const body = mailT(m, "unratedDeal.body", {
        site: site.name,
        onTitle,
        who,
      });
      await deps.email.send({
        to: r.buyerEmail,
        subject,
        text: `${body}\n\n${mailT(m, "unratedDeal.label", { url: rateUrl })}`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body],
          cta: { url: rateUrl, label: mailT(m, "unratedDeal.cta") },
        }),
      });
      deps.analytics?.track({
        name: "rating_nudge_sent",
        props: { dealId: r.dealId },
      });
    } catch (e) {
      logWarn("worker.unrated_deal_nudge_failed", {
        dealId: r.dealId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return rows.length;
}

/**
 * QA-425: buyers churn when supply ignores them — an operator with live,
 * unquoted RFQs past the nudge window gets one "N requests are waiting for
 * your quote" digest deep-linking the Needs-quote inbox view. The sweep's
 * unanswered_mailed_at stamp doubles as a 7-day cooldown, so an idle
 * operator hears about it weekly at most, not once ever and not per tick.
 * Dismissed RFQs and already-quoted ones don't count (needsQuote semantics).
 */
export async function nudgeUnansweredOperators(
  deps: WorkerDeps,
): Promise<number> {
  const hours = deps.unansweredNudgeHours ?? 72;
  if (!(hours > 0)) return 0;
  const now = at(deps).getTime();
  const rows = await deps.repo.sweepUnansweredOperators({
    vertical: deps.vertical,
    olderThan: new Date(now - hours * 3_600_000),
    cooldown: new Date(now - 7 * 86_400_000),
  });
  const origin = `https://${site.domain}`;
  for (const r of rows) {
    try {
      const inboxUrl = `${origin}${localePath(r.locale, "/app/rfqs?f=needs")}`;
      const m = await mailCopy(r.locale);
      const subject = mailT(
        m,
        r.unansweredCount === 1
          ? "opUnanswered.subjectOne"
          : "opUnanswered.subjectMany",
        { count: r.unansweredCount },
      );
      const body = mailT(m, "opUnanswered.body", { site: site.name });
      await deps.email.send({
        to: r.email,
        subject,
        text: `${body}\n\n${mailT(m, "opUnanswered.yourInbox", { url: inboxUrl })}`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body],
          cta: { url: inboxUrl, label: mailT(m, "opUnanswered.cta") },
        }),
      });
      deps.analytics?.track({
        name: "unanswered_nudge_sent",
        props: { operatorId: r.operatorId, unanswered: r.unansweredCount },
      });
    } catch (e) {
      logWarn("worker.unanswered_nudge_failed", {
        operatorId: r.operatorId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return rows.length;
}

/**
 * QA-477: the conversion funnel's first gap — an operator signs up, never
 * lists, and hears nothing again. Supply acquisition is the marketplace's
 * first bottleneck; one mail past the grace window asks them to list.
 * Once-ever: they either act on it or they don't.
 */
export async function nudgeEmptyBookOperators(
  deps: WorkerDeps,
): Promise<number> {
  const hours = deps.emptyBookNudgeHours ?? 48;
  if (!(hours > 0)) return 0;
  const now = at(deps).getTime();
  const rows = await deps.repo.sweepEmptyBookOperators({
    vertical: deps.vertical,
    olderThan: new Date(now - hours * 3_600_000),
  });
  const origin = `https://${site.domain}`;
  for (const r of rows) {
    try {
      const listUrl = `${origin}${localePath(r.locale, "/app/listings/new")}`;
      const m = await mailCopy(r.locale);
      const subject = mailT(m, "opEmptyBook.subject", { site: site.name });
      const body = mailT(m, "opEmptyBook.body");
      await deps.email.send({
        to: r.email,
        subject,
        text: `${body}\n\n${mailT(m, "opEmptyBook.createListingLine", { url: listUrl })}`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body],
          cta: { url: listUrl, label: mailT(m, "opEmptyBook.cta") },
        }),
      });
      deps.analytics?.track({
        name: "empty_book_nudge_sent",
        props: { operatorId: r.operatorId },
      });
    } catch (e) {
      logWarn("worker.empty_book_nudge_failed", {
        operatorId: r.operatorId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return rows.length;
}

/**
 * QA-429: the revenue loop's last gap — a closed deal issues a success-fee
 * invoice at accept time, but a non-payer just sat: admin marks paid/void
 * manually and nothing chased in between. Deals stuck 'invoiced' past the
 * window mail the operator a reminder; the invoice_reminded_at stamp is a
 * 7-day cooldown so a deadbeat hears weekly at most, not per tick.
 */
export async function remindOverdueInvoices(
  deps: WorkerDeps,
): Promise<number> {
  const hours = deps.invoiceReminderHours ?? 72;
  if (!(hours > 0)) return 0;
  const now = at(deps).getTime();
  const rows = await deps.repo.sweepOverdueInvoices({
    vertical: deps.vertical,
    olderThan: new Date(now - hours * 3_600_000),
    cooldown: new Date(now - 7 * 86_400_000),
  });
  const origin = `https://${site.domain}`;
  for (const r of rows) {
    try {
      const fee = fromMinorUnits(r.feeAmountMinor, r.currency as Currency);
      const amount = `${r.currency} ${fee.toLocaleString("en")}`;
      const ref = r.invoiceRef ?? `deal ${r.dealId.slice(0, 8)}`;
      const m = await mailCopy(r.locale);
      const subject = mailT(m, "invoiceOverdue.subject", {
        ref,
        amount,
      });
      const body = mailT(m, "invoiceOverdue.body", {
        amount,
        ref,
        site: site.name,
      });
      const accountUrl = `${origin}${localePath(r.locale, "/app")}`;
      await deps.email.send({
        to: r.email,
        subject,
        text: `${body}\n\n${mailT(m, "invoiceOverdue.yourDeals", { url: accountUrl })}`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body],
          cta: { url: accountUrl, label: mailT(m, "invoiceOverdue.cta") },
        }),
      });
      deps.analytics?.track({
        name: "invoice_reminder_sent",
        props: { dealId: r.dealId, operatorId: r.operatorId },
      });
    } catch (e) {
      logWarn("worker.invoice_reminder_failed", {
        dealId: r.dealId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return rows.length;
}

export async function notifyExpirations(
  deps: WorkerDeps,
  expired: ExpireResultDetailed,
): Promise<void> {
  for (const rfq of expired.rfqs) {
    deps.analytics?.track({ name: "rfq_expired", props: { rfqId: rfq.id } });
    try {
      const m = await mailCopy(rfq.locale);
      const title = rfq.listingTitle ?? mailT(m, "shared.aListing");
      const subject = mailT(m, "requestExpired.subject", { title });
      const body = mailT(m, "requestExpired.body", {
        title,
        site: site.name,
      });
      await deps.email.send({
        to: rfq.buyerEmail,
        subject,
        text: body,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body],
        }),
      });
    } catch (e) {
      logWarn("worker.expiry_email_buyer_failed", {
        rfqId: rfq.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (expired.quotes.length) {
    const contacts = await deps.repo.loadOperatorEmails([
      ...new Set(expired.quotes.map((q) => q.operatorId)),
    ]);
    const emailByOperator = new Map(
      contacts.map((c) => [c.operatorId, c.email] as const),
    );
    const localeByOperator = new Map(
      contacts.map((c) => [c.operatorId, c.locale] as const),
    );
    for (const q of expired.quotes) {
      const to = emailByOperator.get(q.operatorId);
      if (!to) continue;
      deps.analytics?.track({
        name: "quote_expired",
        props: { quoteId: q.id, operatorId: q.operatorId },
      });
      try {
        const m = await mailCopy(localeByOperator.get(q.operatorId));
        const subject = mailT(m, "rfqExpiredOp.subject", {
          title: q.listingTitle ?? mailT(m, "shared.aListing"),
        });
        const body = mailT(m, "rfqExpiredOp.body", { site: site.name });
        await deps.email.send({
          to,
          subject,
          text: body,
          html: brandedEmailHtml({
            siteName: site.name,
            title: subject,
            paragraphs: [body],
          }),
        });
      } catch (e) {
        logWarn("worker.expiry_email_operator_failed", {
          operatorId: q.operatorId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}

/**
 * `email.quote_notification` { matchId }: send the operator an RFQ email via
 * the env-selected email adapter, then mark the match sent (failed on throw —
 * the job retries with backoff).
 */
export async function quoteNotification(
  deps: WorkerDeps,
  payload: unknown,
): Promise<void> {
  const matchId = (payload as { matchId?: unknown })?.matchId;
  if (typeof matchId !== "string" || !matchId) {
    throw new Error("email.quote_notification payload requires matchId: string");
  }
  const ctx = await deps.repo.loadMatchContext(matchId);
  // A match row can be gone by claim time (its rfq/operator was deleted —
  // cascade) or the id never existed (bad payload). Retrying can never fix
  // that, so complete the job instead of burning attempts to `failed`.
  if (!ctx) {
    logWarn("worker.quote_notification_match_gone", { matchId });
    return;
  }
  // Retry dedup: send happens BEFORE markMatchState — a mark failure retries
  // the job and would re-mail the operator. Already-sent means this attempt
  // is a replay of a completed send; skip it (QA-161).
  if (ctx.state === "sent") return;
  // The RFQ can die between match-delivery and this send (accept close,
  // expiry sweep, spam-mark). Notifying operators about a dead request just
  // 409s their quote attempt — skip (QA-169); complete the job, the match
  // stays 'pending' as a delivered-but-dead record.
  if (!["new", "matched", "quoted"].includes(ctx.rfqStatus)) {
    logWarn("worker.quote_notification_rfq_dead", {
      matchId,
      rfqId: ctx.rfqId,
      rfqStatus: ctx.rfqStatus,
    });
    return;
  }

  // QA-505: operator muted match mail — the match row still delivered to
  // their inbox, so mark it 'sent' (leaving 'pending' would re-enqueue via
  // unnotifiedPendingMatches forever); only the email leg is skipped.
  if (!ctx.notifyRfqMatch) {
    logWarn("worker.quote_notification_opted_out", {
      matchId,
      rfqId: ctx.rfqId,
    });
    await deps.repo.markMatchState(matchId, "sent");
    return;
  }

  const f = ctx.rfqFields;
  // QA-494: the fan-out mail renders in the recipient's users.locale —
  // envelope, labels, and the generic buyer fallback all resolve per-mail.
  const m = await mailCopy(ctx.operatorLocale);
  const fieldLabels = await workerFieldLabels(deps, ctx.operatorLocale);
  // Contact fields are masked until a deal closes (QA-152) — name only.
  const buyerName =
    typeof f["name"] === "string" && f["name"]
      ? f["name"]
      : mailT(m, "shared.aBuyer");
  // Details render the vertical's declared fields (labeled, in form order)
  // plus any undeclared extras — was a hardcoded Route/Dates/pax shape that
  // emailed machinery dealers "Route: n/a" (QA-234).
  // Config-derived contact keys (QA-308): a vertical that renames its
  // email/tel field would leak it here under a hardcoded name/email/phone set.
  const CONTACT_KEYS =
    deps.contactKeys ?? new Set(["name", "email", "phone"]);
  const declaredOrder = fieldLabels ? [...fieldLabels.keys()] : [];
  const detailKeys = [
    ...declaredOrder.filter((k) => !CONTACT_KEYS.has(k)),
    ...Object.keys(f).filter(
      (k) => !CONTACT_KEYS.has(k) && !declaredOrder.includes(k),
    ),
  ];
  const detailLines = detailKeys
    .filter((k) => f[k] !== undefined && f[k] !== null && String(f[k]) !== "")
    .map((k) => `${fieldLabels?.get(k) ?? k}: ${String(f[k])}`);
  const route = [f["departure"] ?? f["from"], f["arrival"] ?? f["to"]]
    .filter(Boolean)
    .join(" → ");
  const subject = [mailT(m, "rfqNew.subject"), route, ctx.listingTitle]
    .filter(Boolean)
    .join(" — ");
  // Concierge RFQs are paid expedites — flag them so operators quote first.
  const priorityLine = ctx.rfqConcierge ? mailT(m, "rfqNew.priority") : null;
  const intro = mailT(m, "rfqNew.intro", { site: site.name });
  const buyerLine = mailT(m, "rfqNew.buyer", { name: buyerName });
  const cta = mailT(m, "rfqNew.cta");
  await deps.email.send({
    to: ctx.operatorEmail,
    subject,
    text:
      `${intro}\n\n` +
      `${priorityLine ? `${priorityLine}\n\n` : ""}` +
      `${detailLines.join("\n")}\n` +
      `${buyerLine}\n\n` +
      cta,
    html: brandedEmailHtml({
      siteName: site.name,
      title: subject,
      paragraphs: [
        intro,
        ...(priorityLine ? [priorityLine] : []),
        ...detailLines,
        buyerLine,
        cta,
      ],
    }),
  });
  await deps.repo.markMatchState(matchId, "sent");
}

/** Dispatch a claimed job row to its handler. */
export async function handleJob(
  deps: WorkerDeps,
  kind: string,
  payload: unknown,
): Promise<void> {
  switch (kind) {
    case "rfq.fanout":
      return rfqFanout(deps, payload);
    case "email.quote_notification":
      return quoteNotification(deps, payload);
    default:
      throw new Error(`unknown job kind: ${kind}`);
  }
}
