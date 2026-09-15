import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

// Static per-locale loaders — a dynamic `messages/${locale}` import can't be
// resolved through the package exports map at build time.
const catalogs: Record<
  string,
  () => Promise<{ default: Record<string, unknown> }>
> = {
  en: () => import("@jetmarket/i18n/messages/en.json"),
};

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  if (!locale || !routing.locales.includes(locale as "en")) {
    locale = routing.defaultLocale;
  }
  const load = catalogs[locale] ?? catalogs.en!;
  return {
    locale,
    messages: (await load()).default,
  };
});
