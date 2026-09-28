import type { VerticalConfig } from "./types";

/**
 * RFQ field key -> human label, in rfqFields declaration order — for
 * plain-text surfaces where next-intl isn't wired (worker notification
 * emails, the memory-mode fan-out). `namespace` is the vertical's message
 * subtree (e.g. `en.vertical.machinery`). Keys whose labelKey doesn't
 * resolve are omitted — callers fall back to the raw key.
 */
export function rfqFieldLabels(
  vertical: VerticalConfig,
  namespace: Record<string, unknown>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of vertical.rfqFields) {
    let cur: unknown = namespace;
    for (const part of f.labelKey.split(".")) {
      cur =
        cur && typeof cur === "object"
          ? (cur as Record<string, unknown>)[part]
          : undefined;
    }
    if (typeof cur === "string") out.set(f.key, cur);
  }
  return out;
}
