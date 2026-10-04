export const locales = ["en", "de"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/**
 * Load the message catalog for a locale. Catalogs live in messages/ as
 * `<locale>.json` and are wired here + in apps/web/i18n/request.ts
 * (check:i18n enforces leaf-key + placeholder parity across them).
 */
export async function getMessages(locale: string) {
  switch (locale) {
    case "de":
      return (await import("../messages/de.json")).default;
    case "en":
    default:
      return (await import("../messages/en.json")).default;
  }
}
