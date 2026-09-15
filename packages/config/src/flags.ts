/** Feature flags. Env-driven, safe to check anywhere (server or client). */
export const flags = {
  /** Show the in-app dashboard routes (products enable their app surface) */
  appEnabled: true,
  /** Marketing pricing section */
  pricingEnabled: true,
  /** Blog/changelog surface — off until a product has content */
  blogEnabled: false,
} as const;
