import { todoGoLive } from "../errors";
import type { AuthProvider, MagicLink, Session } from "./types";

const DOCS = "https://supabase.com/docs/guides/auth/auth-email-passwordless";

export interface SupabaseAuthOptions {
  url: string; // SUPABASE_URL
  anonKey: string; // SUPABASE_ANON_KEY
  serviceRoleKey?: string; // SUPABASE_SERVICE_ROLE_KEY
}

/**
 * Supabase Auth (magic-link OTP + JWT sessions). Typed skeleton — the method
 * signatures are final; bodies land at go-live once real keys exist.
 * TODO(go-live): https://supabase.com/docs/guides/auth/auth-email-passwordless
 */
export class SupabaseAuthProvider implements AuthProvider {
  constructor(readonly opts: SupabaseAuthOptions) {}

  requestMagicLink(): Promise<MagicLink> {
    // supabase.auth.signInWithOtp({ email, options: { emailRedirectTo } })
    throw todoGoLive("supabase/auth", "requestMagicLink", DOCS);
  }
  verifyMagicLink(): Promise<Session | null> {
    // supabase.auth.verifyOtp({ token_hash, type: "email" }) -> map to Session
    throw todoGoLive("supabase/auth", "verifyMagicLink", DOCS);
  }
  sessionCookieValue(): string {
    throw todoGoLive("supabase/auth", "sessionCookieValue", DOCS);
  }
  getSession(): Promise<Session | null> {
    // supabase.auth.getUser(jwt) — verify signature + expiry
    throw todoGoLive("supabase/auth", "getSession", DOCS);
  }
  signOut(): Promise<void> {
    throw todoGoLive("supabase/auth", "signOut", DOCS);
  }
}
