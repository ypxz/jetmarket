import { envOf } from "../env";
import type { Env } from "../env";
import { MockAuthProvider } from "./mock";
import { SupabaseAuthProvider } from "./real";
import type { AuthProvider } from "./types";

export * from "./types";
export { MockAuthProvider } from "./mock";
export { SupabaseAuthProvider } from "./real";

export type AuthProviderName = "mock" | "supabase";

export function authProviderName(env?: Env): AuthProviderName {
  const e = envOf(env);
  return (e.AUTH_PROVIDER ?? "mock").toLowerCase() === "supabase"
    ? "supabase"
    : "mock";
}

/**
 * AUTH_PROVIDER: mock (default) | supabase (skeleton).
 * Mock needs SESSION_SECRET (dev default ok) + APP_URL for link building.
 */
export function createAuthProvider(env?: Env): AuthProvider {
  const e = envOf(env);
  switch (authProviderName(e)) {
    case "supabase":
      return new SupabaseAuthProvider({
        url: e.SUPABASE_URL ?? "",
        anonKey: e.SUPABASE_ANON_KEY ?? "",
        serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
      });
    case "mock":
    default:
      return new MockAuthProvider({
        secret: e.SESSION_SECRET ?? "dev-only-not-a-secret",
        appUrl: e.APP_URL,
      });
  }
}

// Singleton survives dev-server HMR via globalThis.
const g = globalThis as unknown as { __jmAuth?: AuthProvider };
export function authProvider(env?: Env): AuthProvider {
  if (!g.__jmAuth) g.__jmAuth = createAuthProvider(env);
  return g.__jmAuth;
}
