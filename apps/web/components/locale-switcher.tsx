"use client";

import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, usePathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

/**
 * Header language toggle. `usePathname` (from i18n/navigation) returns the
 * locale-stripped path; the locale-aware Link re-prefixes it for the target
 * locale. Query params ride along so a filtered /search survives the switch.
 */
export function LocaleSwitcher() {
  const t = useTranslations("nav");
  const locale = useLocale();
  const pathname = usePathname();
  const search = useSearchParams();
  // Two-locale toggle: for >2 this becomes a menu.
  const next: string = routing.locales.find((l: string) => l !== locale) ?? "en";
  const qs = search.toString();
  return (
    <Link
      href={qs ? `${pathname}?${qs}` : pathname}
      locale={next}
      className="shrink-0 text-muted hover:text-foreground"
      data-testid="locale-switch"
      aria-label={t("language", { language: next.toUpperCase() })}
    >
      {next.toUpperCase()}
    </Link>
  );
}
