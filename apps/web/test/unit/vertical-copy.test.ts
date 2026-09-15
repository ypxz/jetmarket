import { describe, expect, it } from "vitest";
import messages from "@jetmarket/i18n/messages/en.json";
import { jetsVertical, machineryVertical } from "@jetmarket/verticals";
import type { VerticalConfig } from "@jetmarket/verticals";

function get(ns: string, key: string): unknown {
  let cur: unknown = messages;
  for (const part of `${ns}.${key}`.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function labelKeys(config: VerticalConfig): string[] {
  const keys: string[] = [
    ...config.listingTypes.map((t) => t.labelKey),
    ...config.attributes.map((a) => a.labelKey),
    ...config.facets.map((f) => f.labelKey),
    ...config.facets.flatMap((f) => (f.options ?? []).map((o) => o.labelKey)),
    ...config.rfqFields.map((f) => f.labelKey),
    ...config.rfqFields
      .map((f) => f.placeholderKey)
      .filter((k): k is string => Boolean(k)),
    ...config.fees.subscriptionPlans.map((p) => p.nameKey),
    ...config.fees.subscriptionPlans.map((p) => p.featuresKey),
    ...config.seo.landingPages.map((p) => p.titleKey),
    ...config.seo.landingPages
      .map((p) => p.introKey)
      .filter((k): k is string => Boolean(k)),
    ...(config.attributes
      .map((a) => a.unitKey)
      .filter((k): k is string => Boolean(k)) ?? []),
  ];
  return [...new Set(keys)];
}

for (const config of [jetsVertical, machineryVertical]) {
  describe(`i18n completeness: ${config.slug}`, () => {
    it("every config labelKey/titleKey resolves in en.json", () => {
      const missing = labelKeys(config).filter(
        (k) => get(config.copy.namespace, k) === undefined,
      );
      expect(missing).toEqual([]);
    });
  });
}
