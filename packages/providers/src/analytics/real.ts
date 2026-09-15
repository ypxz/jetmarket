import type { AnalyticsProvider } from "./types";

/**
 * Real analytics — noop until a vendor is picked at go-live (posthog /
 * plausible / segment). Intentionally silent: dropping events beats shipping
 * wrong ones.
 * TODO(go-live): pick vendor, wire SDK.
 */
export class NoopAnalyticsProvider implements AnalyticsProvider {
  track(): void {}
}
