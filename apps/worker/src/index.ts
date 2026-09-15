import {
  claimJobs,
  completeJob,
  createDb,
  databaseUrl,
  failJob,
} from "@jetmarket/db";
import { defaultPlans } from "@jetmarket/domain";
import { createEmailProvider } from "@jetmarket/providers/email";
import { deliverDueMatches, handleJob, type WorkerDeps } from "./handlers";
import { createWorkerRepo } from "./repo";

const JOB_KINDS = ["rfq.fanout", "email.quote_notification"] as const;
const DEFAULT_POLL_MS = 5_000;
const CLAIM_BATCH = 10;

export function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.WORKER_POLL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_POLL_MS;
}

/** One poll iteration: delayed-match sweep, then claim+handle a batch. */
export async function tick(deps: WorkerDeps): Promise<number> {
  const delivered = await deliverDueMatches(deps);
  if (delivered) console.log(`[worker] delivered ${delivered} delayed match(es)`);

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
