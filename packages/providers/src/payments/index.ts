import { envOf } from "../env";
import type { Env } from "../env";
import { MockPaymentsProvider } from "./mock";
import { StripePaymentsProvider } from "./real";
import type { PaymentsProvider } from "./types";

export * from "./types";
export { MockPaymentsProvider } from "./mock";
export { StripePaymentsProvider } from "./real";

export type PaymentsProviderName = "mock" | "stripe";

export function paymentsProviderName(env?: Env): PaymentsProviderName {
  const e = envOf(env);
  return (e.PAYMENTS_PROVIDER ?? "mock").toLowerCase() === "stripe"
    ? "stripe"
    : "mock";
}

/** PAYMENTS_PROVIDER: mock (default, instant-success) | stripe (SDK). */
export function createPaymentsProvider(env?: Env): PaymentsProvider {
  const e = envOf(env);
  switch (paymentsProviderName(e)) {
    case "stripe":
      return new StripePaymentsProvider({
        secretKey: e.STRIPE_SECRET_KEY ?? "",
        apiBase: e.STRIPE_API_BASE,
        webhookSecret: e.STRIPE_WEBHOOK_SECRET,
      });
    case "mock":
    default:
      return new MockPaymentsProvider({ appUrl: e.APP_URL });
  }
}

// Singleton survives dev-server HMR via globalThis.
const g = globalThis as unknown as { __jmPayments?: PaymentsProvider };
export function paymentsProvider(env?: Env): PaymentsProvider {
  if (!g.__jmPayments) g.__jmPayments = createPaymentsProvider(env);
  return g.__jmPayments;
}
