export interface AnalyticsEvent {
  name: string;
  /** e.g. { rfqId, vertical } — keep values primitives for vendor portability. */
  props?: Record<string, string | number | boolean | null>;
  /** ISO timestamp; impls default to now. */
  at?: string;
}

/**
 * Product analytics. mock = console/captured; real = noop (no vendor chosen —
 * add posthog/plausible at go-live).
 */
export interface AnalyticsProvider {
  track(event: AnalyticsEvent): void;
}
