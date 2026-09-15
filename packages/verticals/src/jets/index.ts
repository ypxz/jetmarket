import { z } from "zod";
import type { VerticalConfig } from "../types";

// Airport code as stored in listings.attributes (IATA or ICAO); normalizes to uppercase.
const AIRPORT = z.preprocess(
  (s) => (typeof s === "string" ? s.trim().toUpperCase() : s),
  z.string().regex(/^[A-Z]{3,4}$/, "expected 3–4 letter airport code"),
);

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected ISO date");

/**
 * Jets vertical: charter, empty legs and aircraft for sale.
 * Attribute keys match the listings.attributes jsonb shape seeded in
 * apps/web/lib/repo (and later @jetmarket/db) — keep them in sync.
 * Price lives on the top-level `Listing.price` field, not in attributes.
 */
export const jetsVertical: VerticalConfig = {
  slug: "jets",
  name: "JetMarket",
  currency: "USD",

  listingTypes: [
    { slug: "charter", labelKey: "listingTypes.charter" },
    { slug: "empty_leg", labelKey: "listingTypes.empty_leg" },
    { slug: "aircraft_sale", labelKey: "listingTypes.aircraft_sale" },
  ],

  attributes: [
    {
      key: "aircraftCategory",
      labelKey: "attributes.aircraftCategory",
      appliesTo: ["charter", "empty_leg", "aircraft_sale"],
      schema: z.enum(["light", "mid", "super_mid", "heavy", "ultra_long"]),
    },
    {
      key: "model",
      labelKey: "attributes.model",
      appliesTo: ["charter", "empty_leg", "aircraft_sale"],
      schema: z.string().min(1).max(80),
    },
    {
      key: "year",
      labelKey: "attributes.year",
      appliesTo: ["charter", "empty_leg", "aircraft_sale"],
      schema: z.number().int().min(1950).max(2035),
    },
    {
      key: "seats",
      labelKey: "attributes.seats",
      appliesTo: ["charter", "empty_leg", "aircraft_sale"],
      schema: z.number().int().min(1).max(30),
      unitKey: "units.seats",
    },
    {
      key: "rangeNm",
      labelKey: "attributes.rangeNm",
      appliesTo: ["charter", "empty_leg", "aircraft_sale"],
      schema: z.number().int().positive().max(15000),
      unitKey: "units.nm",
    },
    {
      key: "baseAirport",
      labelKey: "attributes.baseAirport",
      appliesTo: ["charter"],
      schema: AIRPORT,
    },
    {
      key: "from",
      labelKey: "attributes.from",
      appliesTo: ["empty_leg"],
      schema: AIRPORT,
    },
    {
      key: "to",
      labelKey: "attributes.to",
      appliesTo: ["empty_leg"],
      schema: AIRPORT,
    },
    {
      key: "date",
      labelKey: "attributes.date",
      appliesTo: ["empty_leg"],
      schema: ISO_DATE,
    },
    {
      key: "hoursTotal",
      labelKey: "attributes.hoursTotal",
      appliesTo: ["aircraft_sale"],
      schema: z.number().nonnegative(),
      unitKey: "units.hours",
    },
  ],

  facets: [
    {
      key: "type",
      labelKey: "facets.type",
      type: "enum",
      options: [
        { value: "charter", labelKey: "listingTypes.charter" },
        { value: "empty_leg", labelKey: "listingTypes.empty_leg" },
        { value: "aircraft_sale", labelKey: "listingTypes.aircraft_sale" },
      ],
    },
    {
      key: "aircraftCategory",
      labelKey: "facets.aircraftCategory",
      type: "enum",
      attributeKey: "aircraftCategory",
      options: [
        { value: "light", labelKey: "categories.light" },
        { value: "mid", labelKey: "categories.mid" },
        { value: "super_mid", labelKey: "categories.super_mid" },
        { value: "heavy", labelKey: "categories.heavy" },
        { value: "ultra_long", labelKey: "categories.ultra_long" },
      ],
    },
    {
      key: "from",
      labelKey: "facets.from",
      type: "text",
      attributeKey: "from",
    },
    {
      key: "to",
      labelKey: "facets.to",
      type: "text",
      attributeKey: "to",
    },
    {
      key: "seats",
      labelKey: "facets.seats",
      type: "number-range",
      attributeKey: "seats",
    },
    {
      key: "price",
      labelKey: "facets.price",
      type: "number-range",
    },
  ],

  rfqFields: [
    {
      key: "departure",
      labelKey: "rfq.departure",
      type: "text",
      required: true,
      groupKey: "route",
      schema: z.string().trim().min(2).max(64),
      placeholderKey: "rfq.placeholders.departure",
    },
    {
      key: "arrival",
      labelKey: "rfq.arrival",
      type: "text",
      required: true,
      groupKey: "route",
      schema: z.string().trim().min(2).max(64),
      placeholderKey: "rfq.placeholders.arrival",
    },
    {
      key: "dateFrom",
      labelKey: "rfq.dateFrom",
      type: "date",
      required: true,
      groupKey: "dates",
      schema: ISO_DATE,
    },
    {
      key: "dateTo",
      labelKey: "rfq.dateTo",
      type: "date",
      required: true,
      groupKey: "dates",
      schema: ISO_DATE,
    },
    {
      key: "passengers",
      labelKey: "rfq.passengers",
      type: "number",
      required: true,
      schema: z.coerce.number().int().min(1).max(19),
    },
    {
      key: "budgetUsd",
      labelKey: "rfq.budgetUsd",
      type: "number",
      required: false,
      schema: z.coerce.number().positive().max(50_000_000).optional(),
    },
    {
      key: "name",
      labelKey: "rfq.name",
      type: "text",
      required: true,
      groupKey: "contact",
      schema: z.string().trim().min(2).max(120),
    },
    {
      key: "email",
      labelKey: "rfq.email",
      type: "email",
      required: true,
      groupKey: "contact",
      schema: z.string().trim().email().max(200),
    },
    {
      key: "phone",
      labelKey: "rfq.phone",
      type: "tel",
      required: false,
      groupKey: "contact",
      schema: z.string().trim().max(40).optional(),
    },
    {
      key: "notes",
      labelKey: "rfq.notes",
      type: "textarea",
      required: false,
      schema: z.string().trim().max(2000).optional(),
    },
  ],

  fees: {
    subscriptionPlans: [
      {
        slug: "free",
        nameKey: "plans.free.name",
        monthlyPriceUsd: 0,
        maxListings: 3,
        featuresKey: "plans.free.features",
        rfqDelayHours: 24,
      },
      {
        slug: "pro",
        nameKey: "plans.pro.name",
        monthlyPriceUsd: 199,
        maxListings: null,
        featuresKey: "plans.pro.features",
      },
    ],
    successFeePct: { charter: 3, empty_leg: 3, aircraft_sale: 1.5 },
  },

  copy: { namespace: "vertical.jets" },

  seo: {
    landingPages: [
      {
        slug: "empty-legs-zurich-nice",
        titleKey: "seo.pages.empty-legs-zurich-nice.title",
        introKey: "seo.pages.empty-legs-zurich-nice.intro",
        filters: { type: "empty_leg", from: "ZRH", to: "NCE" },
      },
      {
        slug: "empty-legs-geneva-nice",
        titleKey: "seo.pages.empty-legs-geneva-nice.title",
        introKey: "seo.pages.empty-legs-geneva-nice.intro",
        filters: { type: "empty_leg", from: "GVA", to: "NCE" },
      },
      {
        slug: "empty-legs-london-nice",
        titleKey: "seo.pages.empty-legs-london-nice.title",
        introKey: "seo.pages.empty-legs-london-nice.intro",
        filters: { type: "empty_leg", from: "LTN", to: "NCE" },
      },
      {
        slug: "empty-legs-nice-london",
        titleKey: "seo.pages.empty-legs-nice-london.title",
        introKey: "seo.pages.empty-legs-nice-london.intro",
        filters: { type: "empty_leg", from: "NCE", to: "LTN" },
      },
      {
        slug: "empty-legs-london-zurich",
        titleKey: "seo.pages.empty-legs-london-zurich.title",
        introKey: "seo.pages.empty-legs-london-zurich.intro",
        filters: { type: "empty_leg", from: "LTN", to: "ZRH" },
      },
      {
        slug: "empty-legs-zurich-geneva",
        titleKey: "seo.pages.empty-legs-zurich-geneva.title",
        introKey: "seo.pages.empty-legs-zurich-geneva.intro",
        filters: { type: "empty_leg", from: "ZRH", to: "GVA" },
      },
      {
        slug: "empty-legs-paris-nice",
        titleKey: "seo.pages.empty-legs-paris-nice.title",
        introKey: "seo.pages.empty-legs-paris-nice.intro",
        filters: { type: "empty_leg", from: "LBG", to: "NCE" },
      },
      {
        slug: "empty-legs-zurich-malaga",
        titleKey: "seo.pages.empty-legs-zurich-malaga.title",
        introKey: "seo.pages.empty-legs-zurich-malaga.intro",
        filters: { type: "empty_leg", from: "ZRH", to: "AGP" },
      },
      {
        slug: "empty-legs-geneva-palma",
        titleKey: "seo.pages.empty-legs-geneva-palma.title",
        introKey: "seo.pages.empty-legs-geneva-palma.intro",
        filters: { type: "empty_leg", from: "GVA", to: "PMI" },
      },
      {
        slug: "empty-legs-zurich-ibiza",
        titleKey: "seo.pages.empty-legs-zurich-ibiza.title",
        introKey: "seo.pages.empty-legs-zurich-ibiza.intro",
        filters: { type: "empty_leg", from: "ZRH", to: "IBZ" },
      },
    ],
  },
};
