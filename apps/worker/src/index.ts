import {
  claimJobs,
  completeJob,
  createDb,
  databaseUrl,
  failJob,
  pruneJobs,
  requeueStaleJobs,
} from "@jetmarket/db";
import { getVertical, rfqFieldLabels } from "@jetmarket/verticals";
import en from "@jetmarket/i18n/messages/en.json";
import { createEmailProvider } from "@jetmarket/providers/email";
import { analyticsProvider } from "@jetmarket/providers";
import {
  deliverDueMatches,
  handleJob,
  notifyExpirations,
  recoverUnfanoutedRfqs,
  type WorkerDeps,
} from "./handlers";
import { logError, logInfo } from "./log";
import { createWorkerRepo } from "./repo";

const JOB_KINDS = ["rfq.fanout", "email.quote_notification"] as const;
const DEFAULT_POLL_MS = 5_000;
const CLAIM_BATCH = 10;
const PRUNE_EVERY_MS = 60 * 60_000;
const DONE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const FAILED_RETENTION_MS = 30 * 24 * 60 * 60_000;

let lastPruneAt = 0;

export function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.WORKER_POLL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_POLL_MS;
}

/** One poll iteration: RFQ expiry sweep, delayed-match sweep, then
 * claim+handle a batch. */
export async function tick(deps: WorkerDeps): Promise<number> {
  const expired = await deps.repo.expireRfqs(new Date(), deps.vertical);
  if (expired.rfqs.length || expired.quotes.length) {
    logInfo("worker.expired", {
      rfqs: expired.rfqs.length,
      quotes: expired.quotes.length,
    });
    await notifyExpirations(deps, expired);
  }

  const delivered = await deliverDueMatches(deps);
  if (delivered) logInfo("worker.delivered_matches", { count: delivered });

  // Persisted RFQs whose fan-out job never landed (route enqueue threw
  // post-write, QA-168) — re-enqueue past the grace window.
  const refanouted = await recoverUnfanoutedRfqs(deps);
  if (refanouted) {
    logInfo("worker.refanouted", { rfqs: refanouted });
  }

  // Crash recovery: a worker that dies mid-claim leaves rows 'running'
  // forever — requeue anything untouched for >10 min so it retries.
  const requeued = await requeueStaleJobs(
    deps.sql,
    new Date(Date.now() - 10 * 60_000),
  );
  if (requeued) logInfo("worker.requeued_stale_jobs", { jobs: requeued });

  // Retention: terminal jobs pile up forever otherwise — sweep hourly
  // (done>7d, failed>30d for forensics).
  const nowMs = Date.now();
  if (nowMs - lastPruneAt >= PRUNE_EVERY_MS) {
    lastPruneAt = nowMs;
    const pruned = await pruneJobs(deps.sql, {
      doneOlderThan: new Date(nowMs - DONE_RETENTION_MS),
      failedOlderThan: new Date(nowMs - FAILED_RETENTION_MS),
    });
    if (pruned) logInfo("worker.pruned_jobs", { jobs: pruned });
  }

  const jobs = await claimJobs(
    deps.sql,
    [...JOB_KINDS],
    CLAIM_BATCH,
    undefined,
    deps.vertical,
  );
  for (const job of jobs) {
    try {
      await handleJob(deps, job.kind, job.payload);
      await completeJob(deps.sql, job.id);
    } catch (err) {
      await failJob(
        deps.sql,
        job.id,
        err instanceof Error ? err.message : String(err),
      );
      logError("worker.job_failed", {
        jobId: job.id,
        kind: job.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return jobs.length;
}

async function main() {
  const { db, sql } = createDb(databaseUrl());
  const deps: WorkerDeps = {
    repo: createWorkerRepo(db),
    sql,
    // Scoped sweeps + claims keep a shared DB's other-vertical rows and
    // jobs for that deploy's own worker (QA-295).
    vertical: getVertical().slug,
    email: createEmailProvider(),
    analytics: analyticsProvider(),
    // The active vertical's plan table — a machinery delay must not run
    // jets' 24h defaults (QA-221).
    plans: getVertical().fees.subscriptionPlans,
    // Matching shape is vertical-driven too (fleet listing type, category
    // attribute, RFQ field keys) — QA-229.
    matching: getVertical().matching,
    // RFQ field labels for notification emails — the vertical's declared
    // fields in form order, resolved from the en messages subtree (QA-234).
    fieldLabels: rfqFieldLabels(
      getVertical(),
      ((en.vertical as Record<string, Record<string, unknown>>) ?? {})[
        getVertical().slug
      ] ?? {},
    ),
  };
  const pollMs = pollIntervalMs();
  logInfo("worker.up", { pollMs });

  let stop = false;
  const shutdown = () => {
    stop = true;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Requeue anything stranded 'running' by a previous crash, then loop.
  while (!stop) {
    try {
      const claimed = await tick(deps);
      if (!claimed) await new Promise((r) => setTimeout(r, pollMs));
    } catch (err) {
      logError("worker.tick_error", {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  await sql.end();
  logInfo("worker.stopped");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
