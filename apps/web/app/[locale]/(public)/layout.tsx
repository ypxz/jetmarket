import { SiteFooter } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { site } from "@jetmarket/config";

/**
 * Public route group shell: shared marketing footer with the legal line.
 * The global SiteHeader lives in app/[locale]/layout.tsx above this.
 */
export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = await getTranslations("footer");
  const ct = await getTranslations("common");
  const nt = await getTranslations("nav");
  return (
    <>
      {children}
      <SiteFooter
        name={site.name}
        legalLine={ct("marketplaceNotice")}
        links={[
          { label: t("tos"), href: "/tos" },
          { label: t("privacy"), href: "/privacy" },
          { label: t("imprint"), href: "/imprint" },
          { label: t("contact"), href: `mailto:${site.contactEmail}` },
          { label: nt("design"), href: "/design" },
        ]}
        copyright={t("copyright", {
          year: new Date().getFullYear(),
          name: site.legal.entityName,
        })}
      />
    </>
  );
}
