import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getRepo } from "./repo";
import type { User, UserRole } from "./repo/types";

// Mock auth provider: signed cookie session. Magic links are "delivered" via
// the email mock (tmp/outbox) — in mock mode we also surface the link in the
// sign-in response so the flow is demoable without reading files.
// TODO(go-live): real impl = Supabase magic link (packages/providers/auth).

const COOKIE = "jm_session";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
// Clock skew allowance for a token stamped slightly in the future.
const SKEW_MS = 60_000;

function secret() {
  const s = process.env.SESSION_SECRET;
  // Hardcoded fallback exists for local dev/tests only — in production a
  // missing secret would let anyone forge sessions for arbitrary users.
  if (!s && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production");
  }
  return s ?? "dev-only-not-a-secret";
}

// Tokens are `<userId>.<issuedAtMs>.<hmac>` where the MAC covers the purpose
// tag — a stolen session can't be replayed as a magic link and vice versa.
// Stateless by design (sessions survive restarts); revocation is cookie-level.
type Purpose = "s" | "ml";

function sign(purpose: Purpose, userId: string, iat: number): string {
  return createHmac("sha256", secret())
    .update(`${purpose}:${userId}.${iat}`)
    .digest("hex");
}

function verify(
  purpose: Purpose,
  value: string | undefined,
  ttlMs: number,
): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [userId, iatStr, sig] = parts;
  const iat = Number(iatStr);
  if (!userId || !sig || sig.length !== 64 || !Number.isFinite(iat)) return null;
  const expect = sign(purpose, userId, iat);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const age = Date.now() - iat;
  if (age > ttlMs || age < -SKEW_MS) return null;
  return userId;
}

export function signSession(userId: string): string {
  const iat = Date.now();
  return `${userId}.${iat}.${sign("s", userId, iat)}`;
}

export function verifySession(value: string | undefined): string | null {
  return verify("s", value, SESSION_TTL_MS);
}

export function signMagicLink(userId: string): string {
  const iat = Date.now();
  return `${userId}.${iat}.${sign("ml", userId, iat)}`;
}

export function verifyMagicLink(value: string | undefined): string | null {
  return verify("ml", value, MAGIC_LINK_TTL_MS);
}

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const userId = verifySession(jar.get(COOKIE)?.value);
  if (!userId) return null;
  const repo = await getRepo();
  return (await repo.getUser(userId)) ?? null;
}

export async function requireUser(role?: UserRole): Promise<User | null> {
  const u = await currentUser();
  if (!u) return null;
  if (role && u.role !== role && u.role !== "admin") return null;
  return u;
}

export const sessionCookie = COOKIE;
