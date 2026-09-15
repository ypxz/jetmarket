import { useTranslations } from "next-intl";
import { site } from "@jetmarket/config";
import { Container } from "../layout/primitives";

export function Footer() {
  const t = useTranslations();
  return (
    <footer className="border-t py-8">
      <Container className="flex flex-col items-center justify-between gap-4 text-sm text-muted-foreground sm:flex-row">
        <span>© {new Date().getFullYear()} {site.legalName}</span>
        <nav className="flex gap-4" aria-label={t("footer.legal")}>
          <a href="/legal/terms" className="hover:text-foreground">{t("legal.tos")}</a>
          <a href="/legal/privacy" className="hover:text-foreground">{t("legal.privacy")}</a>
          <a href="/legal/imprint" className="hover:text-foreground">{t("legal.imprint")}</a>
        </nav>
      </Container>
    </footer>
  );
}
