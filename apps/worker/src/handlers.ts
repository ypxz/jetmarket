import type { EmailProvider } from "@jetmarket/providers/email";
import {
  deliverAt,
  matchOperators,
  type Plan,
} from "@jetmarket/domain";
import type { Sql } from "postgres";
import { enqueueJob } from "@jetmarket/db";
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

  const now = at(deps);
  const candidates = await deps.repo.loadOperatorCandidates(rfq.vertical);
  const matches = matchOperators(rfq.fields, candidates, deps.plans, {
    limit: 10,
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
  if (!ctx) throw new Error(`rfq_match ${matchId} not found`);

  const f = ctx.rfqFields;
  const route = [f["departure"] ?? f["from"], f["arrival"] ?? f["to"]]
    .filter(Boolean)
    .join(" → ");
  const pax = f["passengers"] ? ` — ${String(f["passengers"])} pax` : "";
  await deps.email.send({
    to: ctx.operatorEmail,
    subject: `New RFQ ${route}${pax}`.trim(),
    text:
      `You have a new request for quotation on JetMarket.\n\n` +
      `Route: ${route || "n/a"}${pax}\n` +
      `Dates: ${String(f["dateFrom"] ?? "")} – ${String(f["dateTo"] ?? "")}\n` +
      `Buyer: ${ctx.buyerEmail}\n\n` +
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
