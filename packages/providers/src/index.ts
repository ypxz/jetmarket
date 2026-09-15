/**
 * @jetmarket/providers — env-selected external-service adapters.
 * Per service: types.ts (contract) / mock.ts (offline impl) / real.ts (live or
 * typed skeleton) / index.ts (`<svc>ProviderName()`, `create<Svc>Provider`,
 * and the HMR-safe `<svc>Provider()` globalThis singleton).
 */
export * from "./env";
export * from "./errors";

export * as auth from "./auth";
export * as email from "./email";
export * as storage from "./storage";
export * as payments from "./payments";
export * as captcha from "./captcha";
export * as search from "./search";
export * as analytics from "./analytics";

export { authProvider, authProviderName, createAuthProvider } from "./auth";
export { emailProvider, emailProviderName, createEmailProvider } from "./email";
export {
  storageProvider,
  storageProviderName,
  createStorageProvider,
} from "./storage";
export {
  paymentsProvider,
  paymentsProviderName,
  createPaymentsProvider,
} from "./payments";
export {
  captchaProvider,
  captchaProviderName,
  createCaptchaProvider,
} from "./captcha";
export {
  searchProvider,
  searchProviderName,
  createSearchProvider,
} from "./search";
export {
  analyticsProvider,
  analyticsProviderName,
  createAnalyticsProvider,
} from "./analytics";

import type { Sql } from "postgres";
import type { Env } from "./env";
import type { AuthProvider } from "./auth";
import { authProvider } from "./auth";
import type { EmailProvider } from "./email";
import { emailProvider } from "./email";
import type { StorageProvider } from "./storage";
import { storageProvider } from "./storage";
import type { PaymentsProvider } from "./payments";
import { paymentsProvider } from "./payments";
import type { CaptchaProvider } from "./captcha";
import { captchaProvider } from "./captcha";
import type { SearchProvider } from "./search";
import { searchProvider } from "./search";
import type { AnalyticsProvider } from "./analytics";
import { analyticsProvider } from "./analytics";

export interface Providers {
  auth: AuthProvider;
  email: EmailProvider;
  storage: StorageProvider;
  payments: PaymentsProvider;
  captcha: CaptchaProvider;
  search: SearchProvider;
  analytics: AnalyticsProvider;
}

/** All adapters, env-selected. `deps.sql` wires the postgres search impl. */
export function providers(env?: Env, deps?: { sql?: Sql }): Providers {
  return {
    auth: authProvider(env),
    email: emailProvider(env),
    storage: storageProvider(env),
    payments: paymentsProvider(env),
    captcha: captchaProvider(env),
    search: searchProvider(env, deps),
    analytics: analyticsProvider(env),
  };
}
