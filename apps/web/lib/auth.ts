import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getRepo } from "./repo";
import type { User, UserRole } from "./repo/types";

// Mock auth provider: signed cookie session. Magic links are "delivered" via
// the email mock (tmp/outbox) — in mock mode we also surface the link in the
// sign-in response so the flow is demoable without reading files.
// TODO(go-live): real impl = Supabase magic link (packages/providers/auth).

const COOKIE = "jm_session";

function secret() {
  const s = process.env.SESSION_SECRET;
  // Hardcoded fallback exists for local dev/tests only — in production a
  // missing secret would let anyone forge sessions for arbitrary users.
  if (!s && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production");
  }
  return s ?? "dev-only-not-a-secret";
}

export function signSession(userId: string): string {
  const sig = createHmac("sha256", secret()).update(userId).digest("hex");
  return `${userId}.${sig}`;
}

export function verifySession(value: string | undefined): string | null {
  if (!value) return null;
  const [userId, sig] = value.split(".");
  if (!userId || !sig || sig.length !== 64) return null;
  const expect = createHmac("sha256", secret()).update(userId).digest("hex");
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) ? userId : null;
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
