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
    // suppressHydrationWarning: the theme script below mutates the `dark`
    // class before hydration — without it React warns on the attr mismatch.
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* Pre-paint dark mode: without this the effect-only toggle in
            theme-toggle.tsx flashes light on every load for dark users
            (and on cold SSR before hydration). Mirrors KEY = "jm-theme". */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('jm-theme');var on=s?s==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(on)document.documentElement.classList.add('dark')}catch(e){}})()`,
          }}
        />
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          <SiteHeader />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
