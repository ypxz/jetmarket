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

export async function parseBody<T>(
  req: Request,
  schema: ZodSchema<T>,
): Promise<{ data?: T; error?: NextResponse }> {
  let json: unknown;
  try {
    json = await req.json();
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
const buckets = new Map<string, number[]>();
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const nowTs = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => nowTs - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(nowTs);
  buckets.set(key, arr);
  return true;
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "local"
  );
}
