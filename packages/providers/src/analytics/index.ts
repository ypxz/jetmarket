import { envOf } from "../env";
import type { Env } from "../env";
import { MockAnalyticsProvider } from "./mock";
import { NoopAnalyticsProvider } from "./real";
import type { AnalyticsProvider } from "./types";

export * from "./types";
export { MockAnalyticsProvider } from "./mock";
export { NoopAnalyticsProvider } from "./real";

export type AnalyticsProviderName = "mock" | "real";

export function analyticsProviderName(env?: Env): AnalyticsProviderName {
  const e = envOf(env);
  return (e.ANALYTICS_PROVIDER ?? "mock").toLowerCase() === "real"
    ? "real"
    : "mock";
}

/** ANALYTICS_PROVIDER: mock (default, console) | real (noop skeleton). */
export function createAnalyticsProvider(env?: Env): AnalyticsProvider {
  switch (analyticsProviderName(env)) {
    case "real":
      return new NoopAnalyticsProvider();
    case "mock":
    default:
      return new MockAnalyticsProvider();
  }
}

// Singleton survives dev-server HMR via globalThis.
const g = globalThis as unknown as { __jmAnalytics?: AnalyticsProvider };
export function analyticsProvider(env?: Env): AnalyticsProvider {
  if (!g.__jmAnalytics) g.__jmAnalytics = createAnalyticsProvider(env);
  return g.__jmAnalytics;
}
