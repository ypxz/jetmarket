/**
 * Marketing/site content. Copy lives here (and in messages/en.json for
 * localized strings) — blocks in @jetmarket/ui only render it.
 * Entries with `*Key` fields are i18n message keys resolved by the page.
 */
export const content = {
  features: [
    { icon: "zap", titleKey: "features.0.title", bodyKey: "features.0.body" },
    { icon: "shield", titleKey: "features.1.title", bodyKey: "features.1.body" },
    { icon: "globe", titleKey: "features.2.title", bodyKey: "features.2.body" },
    { icon: "coins", titleKey: "features.3.title", bodyKey: "features.3.body" },
  ],
  faq: [
    { qKey: "faq.0.q", aKey: "faq.0.a" },
    { qKey: "faq.1.q", aKey: "faq.1.a" },
    { qKey: "faq.2.q", aKey: "faq.2.a" },
  ],
} as const;

export type Feature = (typeof content.features)[number];
export type FaqItem = (typeof content.faq)[number];
