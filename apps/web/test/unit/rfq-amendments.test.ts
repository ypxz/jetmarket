/**
 * `amendmentDiffs` (QA-538): rung-vs-successor diffs power both the op
 * inbox's "buyer edited" trail and the admin RFQ-flag detail rows —
 * a flag is judged partly on what the buyer rewrote after filing.
 * Pairs: newest rung diffs against LIVE fields, older rungs against the
 * next-newer rung; a rung that differs in nothing drops out.
 */
import { describe, expect, it } from "vitest";
import { amendmentDiffs } from "../../lib/rfq-amendments";
import type { RfqAmendment } from "../../lib/repo/types";

const rung = (id: string, fields: Record<string, unknown>): RfqAmendment => ({
  id,
  rfqId: "r1",
  fields,
  amendedAt: "2026-01-02T00:00:00Z",
});

describe("amendmentDiffs", () => {
  it("newest rung diffs against live fields", () => {
    const lines = amendmentDiffs(
      [rung("a1", { arrival: "NCE", passengers: 4 })],
      { arrival: "GVA", passengers: 4 },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.amendment.id).toBe("a1");
    // The unchanged key never appears; the changed key reads old → new.
    expect(lines[0]!.changes).toEqual([
      { key: "arrival", old: "NCE", next: "GVA" },
    ]);
  });

  it("older rungs diff against the next-newer rung, not live", () => {
    const lines = amendmentDiffs(
      [
        rung("a2", { arrival: "GVA" }), // newest — vs live
        rung("a1", { arrival: "NCE" }), // oldest — vs a2
      ],
      { arrival: "BSL" },
    );
    expect(lines.map((l) => l.changes)).toEqual([
      [{ key: "arrival", old: "GVA", next: "BSL" }],
      [{ key: "arrival", old: "NCE", next: "GVA" }],
    ]);
  });

  it("drops rungs whose superseded map equals the next state", () => {
    const lines = amendmentDiffs(
      [rung("a2", { arrival: "GVA" }), rung("a1", { arrival: "GVA" })],
      { arrival: "GVA" },
    );
    expect(lines).toEqual([]);
  });

  it("a key removed between rungs renders an empty next value", () => {
    const lines = amendmentDiffs(
      [rung("a1", { arrival: "NCE", note: "x" })],
      { arrival: "NCE" },
    );
    expect(lines[0]!.changes).toEqual([{ key: "note", old: "x", next: "—" }]);
  });
});
