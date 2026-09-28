import type { EmailProvider } from "@jetmarket/providers/email";
import { site } from "@jetmarket/config";
import {
  deliverAt,
  matchOperators,
  type Plan,
} from "@jetmarket/domain";
import type { Sql } from "postgres";
import { enqueueJob, type ExpireResultDetailed } from "@jetmarket/db";
import type { WorkerRepo } from "./repo";

export interface WorkerDeps {
  repo: WorkerRepo;
  sql: Sql;
  email: EmailProvider;
  plans: Plan[];
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
  const candidates = await deps.repo.loadOperatorCandidates(rfq.vertical);
  const matches = matchOperators(rfq.fields, candidates, deps.plans, {
    limit: 10,
    // The listing owner is notified directly by the web route — a self-match
    // would double-notify and let them quote their own RFQ.
    ...(rfq.ownerOperatorId
      ? { excludeOperatorIds: new Set([rfq.ownerOperatorId]) }
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
      await enqueueJob(deps.sql, "email.quote_notification", { matchId: m.id });
    }
  }
}

/**
 * Delayed-match sweep — run each poll iteration (and standalone): flip due
 * `delayed` matches to `pending` and enqueue their notification jobs.
 */
export async function deliverDueMatches(deps: WorkerDeps): Promise<number> {
  const ids = await deps.repo.deliverDueMatches(at(deps));
  for (const matchId of ids) {
    await enqueueJob(deps.sql, "email.quote_notification", { matchId });
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
    try {
      await deps.email.send({
        to: rfq.buyerEmail,
        subject: `Your request for “${rfq.listingTitle ?? "a listing"}” has expired`,
        text: `Your request for "${rfq.listingTitle ?? "a listing"}" on ${site.name} expired without an accepted quote. You can submit a fresh request anytime.`,
      });
    } catch (e) {
      console.warn(
        `[worker] expiry email to buyer failed for rfq ${rfq.id}:`,
        e instanceof Error ? e.message : e,
      );
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
      try {
        await deps.email.send({
          to,
          subject: `The RFQ for “${q.listingTitle ?? "a listing"}” expired`,
          text: `The request you quoted on ${site.name} expired before the buyer accepted, so your quote was not selected.`,
        });
      } catch (e) {
        console.warn(
          `[worker] expiry email to operator ${q.operatorId} failed:`,
          e instanceof Error ? e.message : e,
        );
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
    console.warn(
      `[worker] quote_notification: rfq_match ${matchId} gone — skipping`,
    );
    return;
  }

  const f = ctx.rfqFields;
  const route = [f["departure"] ?? f["from"], f["arrival"] ?? f["to"]]
    .filter(Boolean)
    .join(" → ");
  const pax = f["passengers"] ? ` — ${String(f["passengers"])} pax` : "";
  // Buyer contact stays masked until a deal closes (QA-152) — name only.
  const buyerName =
    typeof f["name"] === "string" && f["name"] ? f["name"] : "A buyer";
  await deps.email.send({
    to: ctx.operatorEmail,
    subject: `New RFQ ${route}${pax}`.trim(),
    text:
      `You have a new request for quotation on ${site.name}.\n\n` +
      `Route: ${route || "n/a"}${pax}\n` +
      `Dates: ${String(f["dateFrom"] ?? "")} – ${String(f["dateTo"] ?? "")}\n` +
      `Buyer: ${buyerName}\n\n` +
      `Open your operator inbox to send a quote.`,
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
