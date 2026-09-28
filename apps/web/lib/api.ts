import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";

export function ok(data: unknown, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 });
}

export function err(message: string, status = 400, extra?: unknown) {
  return NextResponse.json(
    { error: message, ...(extra ? { details: extra } : {}) },
    { status },
  );
}

// JSON API payloads here are small (form fields, messages); uploads go
// through multipart on a different route. Cap to bound request-body memory.
const MAX_JSON_BODY_BYTES = 64 * 1024;

export async function parseBody<T>(
  req: Request,
  schema: ZodSchema<T>,
): Promise<{ data?: T; error?: NextResponse }> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_JSON_BODY_BYTES) {
    return { error: err("payload too large", 413) };
  }
  const text = await req.text();
  // No content-length (chunked) still lands here — re-check post-read.
  if (text.length > MAX_JSON_BODY_BYTES) {
    return { error: err("payload too large", 413) };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: err("invalid JSON body") };
  }
  try {
    return { data: schema.parse(json) };
  } catch (e) {
    if (e instanceof ZodError) return { error: err("validation failed", 422, e.issues) };
    throw e;
  }
}

// Simple in-memory rate limiter (per key). Real impl -> Redis/Upstash adapter.
// globalThis so `next dev` recompiles/hot-reloads don't reset the buckets.
const g = globalThis as unknown as { __jmRateBuckets?: Map<string, number[]> };
const buckets = (g.__jmRateBuckets ??= new Map<string, number[]>());
const MAX_BUCKETS = 10_000;
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const nowTs = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => nowTs - t < windowMs);
  if (arr.length === 0) {
    buckets.delete(key);
  } else if (arr.length >= limit) {
    buckets.set(key, arr);
    return false;
  }
  if (buckets.size >= MAX_BUCKETS) {
    // Rotating-IP floods would grow the map unboundedly — drop expired keys,
    // and if still full clear it (a stale burst resets, limiter stays live).
    for (const [k, v] of buckets) {
      if (v.length === 0 || nowTs - (v[v.length - 1] ?? 0) >= windowMs * 4) {
        buckets.delete(k);
      }
    }
    if (buckets.size >= MAX_BUCKETS) buckets.clear();
  }
  arr.push(nowTs);
  buckets.set(key, arr);
  return true;
}

export function clientIp(req: Request): string {
  // Trust order, most→least authoritative: fly-client-ip is set by the Fly
  // edge; x-real-ip is overwritten by reverse proxies (nginx/Cloudflare/
  // Vercel) with the real peer; the LAST x-forwarded-for entry is the hop our
  // immediate upstream appended. The leftmost XFF entry is the client's own
  // claim — freely spoofable, and rotating it minted unlimited rate-limit
  // buckets (QA-140). With no trusted proxy the headers are client-controlled
  // regardless — edge config must strip/overwrite them.
  const xffLast = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return (
    req.headers.get("fly-client-ip") ??
    req.headers.get("x-real-ip") ??
    xffLast ??
    "local"
  );
}

/** True when `e` (or its drizzle/postgres.js `.cause`) is a unique-constraint
 *  violation — the "23505" code and "duplicate key value" detail nest on the
 *  cause, not the wrapper message. */
export function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e; cur; ) {
    if (cur instanceof Error) {
      if (cur.message.includes("duplicate key") || cur.message.includes("23505"))
        return true;
      const code = (cur as { code?: string }).code;
      if (code === "23505") return true;
      cur = cur.cause;
    } else {
      if (String(cur).includes("duplicate key")) return true;
      break;
    }
  }
  return false;
}
