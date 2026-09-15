/**
 * Site-wide content config — placeholders until a real entity/copy lands.
 * Legal pages render these values; replace before go-live (see GO_LIVE.md).
 */
export const site = {
  name: "JetMarket",
  /** Public origin used in absolute links/emails (APP_URL env can override). */
  domain: "jetmarket.example",
  tagline: "Charter, empty legs and aircraft for sale from vetted operators",
  contactEmail: "hello@jetmarket.example",
  legal: {
    /** PLACEHOLDER — replace with the real operating entity before launch. */
    entityName: "JetMarket Ltd (placeholder)",
    addressLine1: "Bahnhofstrasse 1 (placeholder)",
    city: "Zurich",
    postalCode: "8001",
    country: "Switzerland",
    registrationId: "CHE-000.000.000 (placeholder)",
    contactEmail: "legal@jetmarket.example",
  },
} as const;

export type Site = typeof site;
