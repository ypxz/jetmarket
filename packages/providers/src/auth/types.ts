/** Session returned after a successful magic-link verification. */
export interface Session {
  /** Server-side session id (also embedded in the signed cookie). */
  id: string;
  userId: string;
  email: string;
  role: "buyer" | "operator" | "admin";
  /** ISO timestamp after which the session is invalid. */
  expiresAt: string;
}

/** A pending magic-link sign-in (delivered via the email provider). */
export interface MagicLink {
  email: string;
  /** Single-use token embedded in `url`. */
  token: string;
  /** Absolute URL the buyer clicks. */
  url: string;
  /** ISO expiry for the token. */
  expiresAt: string;
}

/**
 * Magic-link auth. Mock issues links + signed cookies fully offline; the
 * supabase impl delegates to Supabase Auth (typed skeleton — TODO(go-live)).
 */
export interface AuthProvider {
  /** Create a single-use magic link for `email`. Caller emails `link.url`. */
  requestMagicLink(
    email: string,
    opts?: { redirectTo?: string; role?: Session["role"] },
  ): Promise<MagicLink>;
  /** Consume a token → session, or null when unknown/expired/used. */
  verifyMagicLink(token: string): Promise<Session | null>;
  /** Signed cookie value for `session` (set as `Set-Cookie`). */
  sessionCookieValue(session: Session): string;
  /** Parse + verify the session cookie from a `Cookie` header. */
  getSession(cookieHeader: string | null | undefined): Promise<Session | null>;
  /** Invalidate a session (logout). */
  signOut(sessionId: string): Promise<void>;
}

export const SESSION_COOKIE_NAME = "jetmarket_session";
