import { afterEach, describe, expect, it, vi } from "vitest";
import { log, logError } from "./log";

describe("log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits one JSON line with level, event, service metadata", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("info", "rfq.created", { rfqId: "r1" });
    expect(spy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("rfq.created");
    expect(parsed.service).toBe("jetmarket-web");
    expect(parsed.rfqId).toBe("r1");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("routes error level to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("provider.failed", { provider: "email" });
    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.parse(spy.mock.calls[0]![0] as string).level).toBe("error");
  });
});
