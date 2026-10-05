import type { RfqAmendment } from "@/lib/repo/types";

/** One visible amendment rung: the edit's own row plus its field diffs. */
export interface AmendmentDiff {
  amendment: RfqAmendment;
  changes: { key: string; old: string; next: string }[];
}

/**
 * QA-538: shared amendment-diff — each stored rung carries the field map
 * the edit SUPERSEDED, so rung i diffs against the next-newer rung (the
 * live fields for the newest). A same-value save logs a rung truthfully
 * but diffs empty; those drop out here so every renderer (operator
 * inbox, admin flag detail) stays identical.
 */
export function amendmentDiffs(
  rungs: RfqAmendment[],
  liveFields: Record<string, unknown>,
): AmendmentDiff[] {
  return rungs
    .map((a, i) => {
      const after = i === 0 ? liveFields : rungs[i - 1]!.fields;
      const changes = [
        ...new Set([...Object.keys(a.fields), ...Object.keys(after)]),
      ]
        .filter((k) => String(a.fields[k] ?? "") !== String(after[k] ?? ""))
        .map((k) => ({
          key: k,
          old: String(a.fields[k] ?? "—"),
          next: String(after[k] ?? "—"),
        }));
      return { amendment: a, changes };
    })
    .filter((l) => l.changes.length > 0);
}
