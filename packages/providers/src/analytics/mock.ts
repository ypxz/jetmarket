import type { AnalyticsEvent, AnalyticsProvider } from "./types";

/**
 * Console/captured analytics for mock mode — events go to console.debug and
 * `events` for test assertions. The buffer is a rolling tail: the singleton
 * outlives the process, so in a long mock-mode run an unbounded array would
 * leak memory per tracked event (QA-359).
 */
const MAX_EVENTS = 1000;

export class MockAnalyticsProvider implements AnalyticsProvider {
  readonly events: AnalyticsEvent[] = [];

  constructor(private readonly opts: { log?: boolean } = {}) {}

  track(event: AnalyticsEvent): void {
    const e = { ...event, at: event.at ?? new Date().toISOString() };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    if (this.opts.log ?? true) {
      console.debug(`[analytics] ${e.name}`, e.props ?? {});
    }
  }
}
