import { describe, expect, it } from "vitest";
import { rfqDeadlineAt } from "../../lib/rfq-deadline";

// QA-442: the display deadline must match the worker sweep exactly —
// dated requests live THROUGH dateTo (the sweep flips them once
// dateTo < today); undated/malformed rows get the 30-day stale horizon.
describe("rfqDeadlineAt", () => {
  const createdAt = "2026-01-10T12:00:00.000Z";

  it("dated request dies at the UTC midnight after dateTo", () => {
    const d = rfqDeadlineAt({
      createdAt,
      fields: { dateTo: "2026-02-14" },
    });
    expect(d.toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });

  it("undated request dies at createdAt + 30 days", () => {
    const d = rfqDeadlineAt({ createdAt, fields: { from: "ZRH" } });
    expect(d.toISOString()).toBe("2026-02-09T12:00:00.000Z");
  });

  it("malformed dateTo falls back to the 30-day horizon", () => {
    for (const bad of ["14 Feb 2026", "2026/02/14", "next week", ""]) {
      const d = rfqDeadlineAt({ createdAt, fields: { dateTo: bad } });
      expect(d.toISOString()).toBe("2026-02-09T12:00:00.000Z");
    }
  });
});
