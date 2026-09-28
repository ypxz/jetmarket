import type { EmailProvider } from "@jetmarket/providers/email";
import { brandedEmailHtml } from "@jetmarket/providers/email";
import type { AnalyticsProvider } from "@jetmarket/providers/analytics";
import { site } from "@jetmarket/config";
import {
  deliverAt,
  matchOperators,
  type Plan,
} from "@jetmarket/domain";
import type { Sql } from "postgres";
import type { MatchingConfig } from "@jetmarket/verticals";
import { enqueueJob, type ExpireResultDetailed } from "@jetmarket/db";
import { logWarn } from "./log";
import type { WorkerRepo } from "./repo";

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
  analytics?: AnalyticsProvider;
  now?: () => Date;
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
  // Fan-out is a one-shot transition off `new`: an RFQ that closed, expired,
  // or was already matched between enqueue and tick must not re-fan-out (or
  // re-notify operators for a dead request).
  if (rfq.status !== "new") return;

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

  const inserted = await deps.repo.insertMatches(
    matches.map((m) => ({
      rfqId: rfq.id,
      operatorId: m.operatorId,
      listingId: m.listingId,
      state: m.delivery === "instant" ? "pending" : "delayed",
      deliverAt: m.delivery === "instant" ? now : deliverAt(m, now),
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
export async function notifyExpirations(
  deps: WorkerDeps,
  expired: ExpireResultDetailed,
): Promise<void> {
  for (const rfq of expired.rfqs) {
    deps.analytics?.track({ name: "rfq_expired", props: { rfqId: rfq.id } });
    try {
      const subject = `Your request for “${rfq.listingTitle ?? "a listing"}” has expired`;
      const body = `Your request for "${rfq.listingTitle ?? "a listing"}" on ${site.name} expired without an accepted quote. You can submit a fresh request anytime.`;
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
    for (const q of expired.quotes) {
      const to = emailByOperator.get(q.operatorId);
      if (!to) continue;
      deps.analytics?.track({
        name: "quote_expired",
        props: { quoteId: q.id, operatorId: q.operatorId },
      });
      try {
        const subject = `The RFQ for “${q.listingTitle ?? "a listing"}” expired`;
        const body = `The request you quoted on ${site.name} expired before the buyer accepted, so your quote was not selected.`;
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

  const f = ctx.rfqFields;
  // Contact fields are masked until a deal closes (QA-152) — name only.
  const buyerName =
    typeof f["name"] === "string" && f["name"] ? f["name"] : "A buyer";
  // Details render the vertical's declared fields (labeled, in form order)
  // plus any undeclared extras — was a hardcoded Route/Dates/pax shape that
  // emailed machinery dealers "Route: n/a" (QA-234).
  const CONTACT_KEYS = new Set(["name", "email", "phone"]);
  const declaredOrder = deps.fieldLabels ? [...deps.fieldLabels.keys()] : [];
  const detailKeys = [
    ...declaredOrder.filter((k) => !CONTACT_KEYS.has(k)),
    ...Object.keys(f).filter(
      (k) => !CONTACT_KEYS.has(k) && !declaredOrder.includes(k),
    ),
  ];
  const detailLines = detailKeys
    .filter((k) => f[k] !== undefined && f[k] !== null && String(f[k]) !== "")
    .map((k) => `${deps.fieldLabels?.get(k) ?? k}: ${String(f[k])}`);
  const route = [f["departure"] ?? f["from"], f["arrival"] ?? f["to"]]
    .filter(Boolean)
    .join(" → ");
  const subject = ["New RFQ", route, ctx.listingTitle]
    .filter(Boolean)
    .join(" — ");
  await deps.email.send({
    to: ctx.operatorEmail,
    subject,
    text:
      `You have a new request for quotation on ${site.name}.\n\n` +
      `${detailLines.join("\n")}\n` +
      `Buyer: ${buyerName}\n\n` +
      `Open your operator inbox to send a quote.`,
    html: brandedEmailHtml({
      siteName: site.name,
      title: subject,
      paragraphs: [
        `You have a new request for quotation on ${site.name}.`,
        ...detailLines,
        `Buyer: ${buyerName}`,
        "Open your operator inbox to send a quote.",
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
