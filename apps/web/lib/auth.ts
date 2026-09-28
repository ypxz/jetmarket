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

// Magic links are `<userId>.<issuedAtMs>.<hmac>`; sessions are
// `<userId>.<issuedAtMs>.<sessionVersion>.<hmac>`. The MAC covers the purpose
// tag — a stolen session can't be replayed as a magic link and vice versa.
// Sessions carry users.session_version so logout revokes server-side: bump the
// version and every outstanding cookie — including a stolen one — fails the
// comparison in currentUser. Magic links keep the 3-part form (15-min TTL,
// one-shot, not worth versioning).
type Purpose = "s" | "ml";

function sign(purpose: Purpose, payload: string): string {
  return createHmac("sha256", secret())
    .update(`${purpose}:${payload}`)
    .digest("hex");
}

function verifyParts(
  value: string | undefined,
  parts: number,
): string[] | null {
  if (!value) return null;
  const p = value.split(".");
  if (p.length !== parts) return null;
  const [userId, iatStr] = p;
  const iat = Number(iatStr);
  const sig = p[p.length - 1];
  if (!userId || !sig || sig.length !== 64 || !Number.isFinite(iat)) return null;
  const age = Date.now() - iat;
  if (age > Number.MAX_SAFE_INTEGER || age < -SKEW_MS) return null;
  return p;
}

export function signSession(userId: string, sessionVersion: number): string {
  const iat = Date.now();
  return `${userId}.${iat}.${sessionVersion}.${sign("s", `${userId}.${iat}.${sessionVersion}`)}`;
}

/** Returns the embedded userId+version; caller compares against the row. */
export function verifySession(
  value: string | undefined,
): { userId: string; sessionVersion: number } | null {
  const p = verifyParts(value, 4);
  if (!p) return null;
  const [userId, , verStr, sig] = p;
  const iat = Number(p[1]);
  const ver = Number(verStr);
  if (!Number.isInteger(ver) || ver < 1) return null;
  if (Date.now() - iat > SESSION_TTL_MS) return null;
  const expect = sign("s", `${userId}.${iat}.${ver}`);
  const a = Buffer.from(sig!);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { userId: userId!, sessionVersion: ver };
}

export function signMagicLink(userId: string): string {
  const iat = Date.now();
  return `${userId}.${iat}.${sign("ml", `${userId}.${iat}`)}`;
}

export function verifyMagicLink(value: string | undefined): string | null {
  const p = verifyParts(value, 3);
  if (!p) return null;
  const [userId, iatStr, sig] = p;
  const iat = Number(iatStr);
  if (Date.now() - iat > MAGIC_LINK_TTL_MS) return null;
  const expect = sign("ml", `${userId}.${iat}`);
  const a = Buffer.from(sig!);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId!;
}

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const sess = verifySession(jar.get(COOKIE)?.value);
  if (!sess) return null;
  const repo = await getRepo();
  const user = await repo.getUser(sess.userId);
  // Server-side revocation: version drift (logout bumps it) kills the session.
  if (!user || user.sessionVersion !== sess.sessionVersion) return null;
  return user;
}

export async function requireUser(role?: UserRole): Promise<User | null> {
  const u = await currentUser();
  if (!u) return null;
  if (role && u.role !== role && u.role !== "admin") return null;
  return u;
}

export const sessionCookie = COOKIE;
