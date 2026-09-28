import { getVertical } from "@jetmarket/verticals";

/**
 * Site-wide content config — placeholders until a real entity/copy lands.
 * Legal pages render these values; replace before go-live (see GO_LIVE.md).
 *
 * `name`/`tagline` resolve from the active vertical (VERTICAL env) so a
 * machinery deploy brands itself MachineryMarket everywhere — only read
 * `site` server-side (client bundles can't see VERTICAL and get jets).
 */
const vertical = getVertical();

export const site = {
  name: vertical.name,
  /** Public origin used in absolute links/emails (APP_URL env can override). */
  domain: "jetmarket.example",
  tagline:
    vertical.tagline ??
    "High-ticket marketplace connecting buyers with vetted operators",
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
