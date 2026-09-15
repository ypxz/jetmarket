import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthProvider, MagicLink, Session } from "./types";
import { SESSION_COOKIE_NAME } from "./types";

export interface MockAuthOptions {
  /** HMAC key for session-cookie signatures (SESSION_SECRET env). */
  secret: string;
  /** Base URL used when building magic links (APP_URL env). */
  appUrl?: string;
  /** Magic-link token TTL, ms. Default 15 min. */
  linkTtlMs?: number;
  /** Session TTL, ms. Default 30 days. */
  sessionTtlMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

const TOKEN_BYTES = 24;

interface PendingLink {
  email: string;
  role: Session["role"];
  redirectTo?: string;
  expiresAt: number;
}

/**
 * Fully-offline auth: magic links are single-use tokens held in memory, and
 * sessions are <id>.<hmac> cookies verified against `secret`. Everything is
 * deterministic given a `now` clock — suitable for tests and mock mode.
 */
export class MockAuthProvider implements AuthProvider {
  private readonly pending = new Map<string, PendingLink>();
  private readonly sessions = new Map<string, Session>();
  private readonly opts: Required<Omit<MockAuthOptions, "redirectTo">>;

  constructor(opts: MockAuthOptions) {
    this.opts = {
      appUrl: "http://localhost:3000",
      linkTtlMs: 15 * 60_000,
      sessionTtlMs: 30 * 24 * 3_600_000,
      now: () => new Date(),
      ...opts,
    };
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.opts.secret).update(payload).digest("hex");
  }

  async requestMagicLink(
    email: string,
    opts?: { redirectTo?: string; role?: Session["role"] },
  ): Promise<MagicLink> {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const expiresAt = this.opts.now().getTime() + this.opts.linkTtlMs;
    this.pending.set(token, {
      email: email.trim().toLowerCase(),
      role: opts?.role ?? "operator",
      redirectTo: opts?.redirectTo,
      expiresAt,
    });
    const url =
      `${this.opts.appUrl}/api/auth/verify?token=${token}` +
      (opts?.redirectTo ? `&next=${encodeURIComponent(opts.redirectTo)}` : "");
    return { email, token, url, expiresAt: new Date(expiresAt).toISOString() };
  }

  async verifyMagicLink(token: string): Promise<Session | null> {
    const link = this.pending.get(token);
    if (!link) return null;
    this.pending.delete(token); // single-use
    if (link.expiresAt < this.opts.now().getTime()) return null;
    const id = randomBytes(16).toString("hex");
    const session: Session = {
      id,
      userId: `mock-user-${link.email}`,
      email: link.email,
      role: link.role,
      expiresAt: new Date(
        this.opts.now().getTime() + this.opts.sessionTtlMs,
      ).toISOString(),
    };
    this.sessions.set(id, session);
    return session;
  }

  sessionCookieValue(session: Session): string {
    return `${session.id}.${this.sign(session.id)}`;
  }

  async getSession(
    cookieHeader: string | null | undefined,
  ): Promise<Session | null> {
    if (!cookieHeader) return null;
    const raw = cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.slice(SESSION_COOKIE_NAME.length + 1);
    if (!raw) return null;
    const dot = raw.lastIndexOf(".");
    if (dot <= 0) return null;
    const id = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expected = this.sign(id);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() < this.opts.now().getTime()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  async signOut(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /** Test/introspection helpers — not part of the AuthProvider contract. */
  pendingLinkCount(): number {
    return this.pending.size;
  }
  activeSessionCount(): number {
    return this.sessions.size;
  }
}
