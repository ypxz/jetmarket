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
}

export async function enqueueJob(
  sql: Sql,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into jobs (kind, payload, run_at, max_attempts)
    values (
      ${kind},
      ${JSON.stringify(payload)}::jsonb,
      ${(opts.runAt ?? new Date()).toISOString()},
      ${opts.maxAttempts ?? 5}
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
): Promise<JobRow[]> {
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
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update jobs set status = 'pending', updated_at = now()
     where status = 'running' and updated_at < ${staleBefore.toISOString()}
    returning id
  `;
  return rows.length;
}
