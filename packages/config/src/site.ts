/**
 * Site identity for JetMarket. Legal/marketing pages read from here.
 */
export const site = {
  name: process.env.NEXT_PUBLIC_SITE_NAME ?? "JetMarket",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  description:
    "The modular high-ticket marketplace: charter jets, empty legs and aircraft sales — one core, swappable verticals.",
  /** Legal entity shown on imprint/ToS/privacy pages */
  legalName: "JetMarket Ltd.",
  legalAddress: "Bahnhofstrasse 1, 8000 Zurich, Switzerland",
  legalEmail: "legal@jetmarket.example",
  supportEmail: "support@jetmarket.example",
} as const;

export type Site = typeof site;
