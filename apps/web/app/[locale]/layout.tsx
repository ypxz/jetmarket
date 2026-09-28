import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { siteUrl } from "@/lib/seo";
import { verticalConfig } from "@/lib/vertical";
import "../globals.css";

// Title/description come from the active vertical's seo namespace so each
// deployment brands itself.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations(`${verticalConfig().copy.namespace}.seo`);
  return {
    metadataBase: new URL(siteUrl()),
    title: t("siteTitle"),
    description: t("siteDescription"),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as "en")) notFound();
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider messages={messages}>
          <SiteHeader />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
