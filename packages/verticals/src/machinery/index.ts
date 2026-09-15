import { z } from "zod";
import type { VerticalConfig } from "../types";

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected ISO date");

/**
 * Machinery vertical — scaffold config proving the abstraction works for a
 * second vertical (incl. decommissioned industrial equipment). Taxonomy and
 * pricing are placeholders; fill in when the vertical is activated (T16).
 */
export const machineryVertical: VerticalConfig = {
  slug: "machinery",
  name: "MachineryMarket",
  currency: "EUR",

  listingTypes: [
    { slug: "for_sale", labelKey: "listingTypes.for_sale" },
    { slug: "for_rent", labelKey: "listingTypes.for_rent" },
    { slug: "auction", labelKey: "listingTypes.auction" },
  ],

  attributes: [
    {
      key: "machineryCategory",
      labelKey: "attributes.machineryCategory",
      appliesTo: ["for_sale", "for_rent", "auction"],
      schema: z.enum([
        "cnc_milling",
        "lathe",
        "press",
        "conveyor",
        "forklift",
        "generator",
        "other",
      ]),
    },
    {
      key: "make",
      labelKey: "attributes.make",
      appliesTo: ["for_sale", "for_rent", "auction"],
      schema: z.string().min(1).max(80),
    },
    {
      key: "yearOfManufacture",
      labelKey: "attributes.yearOfManufacture",
      appliesTo: ["for_sale", "for_rent", "auction"],
      schema: z.number().int().min(1930).max(2035),
    },
    {
      key: "hoursUsed",
      labelKey: "attributes.hoursUsed",
      appliesTo: ["for_sale", "for_rent", "auction"],
      schema: z.number().nonnegative().optional(),
      unitKey: "units.hours",
    },
    {
      key: "weightKg",
      labelKey: "attributes.weightKg",
      appliesTo: ["for_sale", "for_rent", "auction"],
      schema: z.number().positive().optional(),
      unitKey: "units.kg",
    },
    {
      key: "locationCountry",
      labelKey: "attributes.locationCountry",
      appliesTo: ["for_sale", "for_rent", "auction"],
      schema: z.string().length(2),
    },
    {
      key: "monthlyRentEur",
      labelKey: "attributes.monthlyRentEur",
      appliesTo: ["for_rent"],
      schema: z.number().positive(),
    },
  ],

  facets: [
    {
      key: "type",
      labelKey: "facets.type",
      type: "enum",
      options: [
        { value: "for_sale", labelKey: "listingTypes.for_sale" },
        { value: "for_rent", labelKey: "listingTypes.for_rent" },
        { value: "auction", labelKey: "listingTypes.auction" },
      ],
    },
    {
      key: "machineryCategory",
      labelKey: "facets.machineryCategory",
      type: "enum",
      attributeKey: "machineryCategory",
      options: [
        { value: "cnc_milling", labelKey: "categories.cnc_milling" },
        { value: "lathe", labelKey: "categories.lathe" },
        { value: "press", labelKey: "categories.press" },
        { value: "conveyor", labelKey: "categories.conveyor" },
        { value: "forklift", labelKey: "categories.forklift" },
        { value: "generator", labelKey: "categories.generator" },
        { value: "other", labelKey: "categories.other" },
      ],
    },
    {
      key: "price",
      labelKey: "facets.price",
      type: "number-range",
    },
    {
      key: "locationCountry",
      labelKey: "facets.locationCountry",
      type: "text",
      attributeKey: "locationCountry",
    },
  ],

  rfqFields: [
    {
      key: "deliveryPostcode",
      labelKey: "rfq.deliveryPostcode",
      type: "text",
      required: false,
      schema: z.string().trim().max(16).optional(),
    },
    {
      key: "dateFrom",
      labelKey: "rfq.dateFrom",
      type: "date",
      required: false,
      groupKey: "dates",
      schema: ISO_DATE.optional(),
    },
    {
      key: "dateTo",
      labelKey: "rfq.dateTo",
      type: "date",
      required: false,
      groupKey: "dates",
      schema: ISO_DATE.optional(),
    },
    {
      key: "budgetEur",
      labelKey: "rfq.budgetEur",
      type: "number",
      required: false,
      schema: z.coerce.number().positive().max(100_000_000).optional(),
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
        monthlyPriceUsd: 149,
        maxListings: null,
        featuresKey: "plans.pro.features",
      },
    ],
    successFeePct: { for_sale: 2, for_rent: 1.5, auction: 2 },
  },

  copy: { namespace: "vertical.machinery" },

  seo: {
    landingPages: [
      {
        slug: "used-cnc-milling-machines",
        titleKey: "seo.pages.used-cnc-milling-machines.title",
        filters: { type: "for_sale", machineryCategory: "cnc_milling" },
      },
      {
        slug: "used-forklifts-for-sale",
        titleKey: "seo.pages.used-forklifts-for-sale.title",
        filters: { type: "for_sale", machineryCategory: "forklift" },
      },
      {
        slug: "industrial-generators-for-rent",
        titleKey: "seo.pages.industrial-generators-for-rent.title",
        filters: { type: "for_rent", machineryCategory: "generator" },
      },
    ],
  },
};
