/** Locale-aware formatting helpers (Intl-based; currency from plan config). */

export function formatPrice(
  cents: number,
  currency: string,
  locale: string = "en",
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function formatDate(date: Date | number, locale: string = "en"): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

export function formatNumber(value: number, locale: string = "en"): string {
  return new Intl.NumberFormat(locale).format(value);
}
