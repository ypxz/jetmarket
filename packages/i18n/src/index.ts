export const locales = ["en"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/**
 * Load the message catalog for a locale. Only `en` ships; add locales by
 * dropping a `<locale>.json` into messages/ and extending `locales`.
 */
export async function getMessages(locale: string) {
  switch (locale) {
    case "en":
    default:
      return (await import("../messages/en.json")).default;
  }
}
