import type { AnalyticsEvent, AnalyticsProvider } from "./types";

/**
 * Console/captured analytics for mock mode — events go to console.debug and
 * `events` for test assertions.
 */
export class MockAnalyticsProvider implements AnalyticsProvider {
  readonly events: AnalyticsEvent[] = [];

  constructor(private readonly opts: { log?: boolean } = {}) {}

  track(event: AnalyticsEvent): void {
    const e = { ...event, at: event.at ?? new Date().toISOString() };
    this.events.push(e);
    if (this.opts.log ?? true) {
      console.debug(`[analytics] ${e.name}`, e.props ?? {});
    }
  }
}
