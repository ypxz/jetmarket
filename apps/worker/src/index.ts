import {
  claimJobs,
  completeJob,
  createDb,
  databaseUrl,
  failJob,
  pruneJobs,
  requeueStaleJobs,
} from "@jetmarket/db";
import { defaultPlans } from "@jetmarket/domain";
import { createEmailProvider } from "@jetmarket/providers/email";
import {
  deliverDueMatches,
  handleJob,
  notifyExpirations,
  type WorkerDeps,
} from "./handlers";
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
  const expired = await deps.repo.expireRfqs(new Date());
  if (expired.rfqs.length || expired.quotes.length) {
    console.log(
      `[worker] expired ${expired.rfqs.length} rfq(s), declined ${expired.quotes.length} quote(s)`,
    );
    await notifyExpirations(deps, expired);
  }

  const delivered = await deliverDueMatches(deps);
  if (delivered) console.log(`[worker] delivered ${delivered} delayed match(es)`);

  // Crash recovery: a worker that dies mid-claim leaves rows 'running'
  // forever — requeue anything untouched for >10 min so it retries.
  const requeued = await requeueStaleJobs(
    deps.sql,
    new Date(Date.now() - 10 * 60_000),
  );
  if (requeued) console.log(`[worker] requeued ${requeued} stale job(s)`);

  // Retention: terminal jobs pile up forever otherwise — sweep hourly
  // (done>7d, failed>30d for forensics).
  const nowMs = Date.now();
  if (nowMs - lastPruneAt >= PRUNE_EVERY_MS) {
    lastPruneAt = nowMs;
    const pruned = await pruneJobs(deps.sql, {
      doneOlderThan: new Date(nowMs - DONE_RETENTION_MS),
      failedOlderThan: new Date(nowMs - FAILED_RETENTION_MS),
    });
    if (pruned) console.log(`[worker] pruned ${pruned} terminal job(s)`);
  }

  const jobs = await claimJobs(deps.sql, [...JOB_KINDS], CLAIM_BATCH);
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
      console.error(`[worker] job ${job.id} (${job.kind}) failed:`, err);
    }
  }
  return jobs.length;
}

async function main() {
  const { db, sql } = createDb(databaseUrl());
  const deps: WorkerDeps = {
    repo: createWorkerRepo(db),
    sql,
    email: createEmailProvider(),
    plans: defaultPlans(),
  };
  const pollMs = pollIntervalMs();
  console.log(`[worker] up — polling jobs every ${pollMs}ms`);

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
      console.error("[worker] tick error:", err);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  await sql.end();
  console.log("[worker] stopped");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
