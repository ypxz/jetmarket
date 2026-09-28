/**
 * jobs-table helpers for apps/worker: enqueue, claim (SKIP LOCKED so multiple
 * workers can poll safely), complete, fail-with-backoff.
 */
import type { Sql } from "./client";
import type { JobRow } from "./schema";

export type JobKind = "rfq.fanout" | "email.quote_notification" | (string & {});

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /** Owning vertical — on a shared DB only that vertical's worker claims
   * the row (QA-295). NULL jobs stay claimable by every worker. */
  vertical?: string;
}

export async function enqueueJob(
  sql: Sql,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into jobs (kind, payload, run_at, max_attempts, vertical)
    values (
      ${kind},
      ${JSON.stringify(payload)}::jsonb,
      ${(opts.runAt ?? new Date()).toISOString()},
      ${opts.maxAttempts ?? 5},
      ${opts.vertical ?? null}
    )
    returning id
  `;
  return rows[0]!.id;
}

/**
 * Claim up to `limit` due jobs of the given kinds. Rows are marked `running`
 * and attempts incremented atomically; SKIP LOCKED makes this safe to call
 * from concurrent workers.
 */
export async function claimJobs(
  sql: Sql,
  kinds: string[],
  limit = 10,
  now: Date = new Date(),
  /** Claim only jobs owned by this vertical (plus unscoped NULL rows) —
   * omit to claim anything (shared-DB deployments must always pass it). */
  vertical?: string,
): Promise<JobRow[]> {
  const vcond = vertical
    ? sql`and (vertical is null or vertical = ${vertical})`
    : sql``;
  return sql<JobRow[]>`
    update jobs
       set status = 'running',
           attempts = attempts + 1,
           updated_at = now()
     where id in (
       select id from jobs
        where status = 'pending'
          and run_at <= ${now.toISOString()}
          and kind = any(${kinds})
          ${vcond}
        order by run_at
        limit ${limit}
        for update skip locked
     )
     returning *
  `;
}

export async function completeJob(sql: Sql, id: string): Promise<void> {
  await sql`
    update jobs set status = 'done', updated_at = now() where id = ${id}
  `;
}

/**
 * Requeue with exponential-ish backoff (attempts * backoffMs) until
 * max_attempts, then mark `failed`.
 */
export async function failJob(
  sql: Sql,
  id: string,
  error: string,
  backoffMs = 60_000,
): Promise<void> {
  await sql`
    update jobs
       set status = case when attempts >= max_attempts then 'failed' else 'pending' end,
           run_at = case when attempts >= max_attempts then run_at
                         else now() + (${backoffMs} * attempts || ' milliseconds')::interval end,
           last_error = ${error},
           updated_at = now()
     where id = ${id}
  `;
}

/** Requeue jobs stuck 'running' (worker died mid-claim). For sweeps/tests. */
export async function requeueStaleJobs(
  sql: Sql,
  staleBefore: Date,
  /** Same scoping as claimJobs — a worker must not churn foreign-vertical
   *  stuck rows on a shared DB; NULL stays fair game (QA-304). */
  vertical?: string,
): Promise<number> {
  const vcond = vertical
    ? sql`and (vertical is null or vertical = ${vertical})`
    : sql``;
  const rows = await sql<{ id: string }[]>`
    update jobs set status = 'pending', updated_at = now()
     where status = 'running' and updated_at < ${staleBefore.toISOString()}
     ${vcond}
    returning id
  `;
  return rows.length;
}

/**
 * Delete terminal jobs past their retention cutoffs so the table stays small:
 * `done` rows beyond doneOlderThan, `failed` rows beyond failedOlderThan.
 * Pending/running rows are never pruned. Returns the number deleted.
 */
export async function pruneJobs(
  sql: Sql,
  opts: { doneOlderThan: Date; failedOlderThan: Date; vertical?: string },
): Promise<number> {
  // Shared-DB: pruning must not erase another deploy's terminal history —
  // NULL (legacy/unscoped) rows are fair game for whoever prunes first.
  const vcond = opts.vertical
    ? sql`and (vertical is null or vertical = ${opts.vertical})`
    : sql``;
  const rows = await sql<{ id: string }[]>`
    delete from jobs
     where ((status = 'done'   and updated_at < ${opts.doneOlderThan.toISOString()})
        or  (status = 'failed' and updated_at < ${opts.failedOlderThan.toISOString()}))
       ${vcond}
    returning id
  `;
  return rows.length;
}
