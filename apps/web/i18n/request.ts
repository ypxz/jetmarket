import { getRequestConfig } from "next-intl/server";
import { getMessages } from "@jetmarket/i18n";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  if (!locale || !routing.locales.includes(locale as "en")) {
    locale = routing.defaultLocale;
  }
  return {
    locale,
    messages: await getMessages(locale),
  };
});
