/** Currency display helper — currency comes from the listing/config. */
export function formatMoney(
  amount: number,
  currency: string,
  locale = "en",
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString(locale)}`;
  }
}

/** Format a listing attribute value for display (server-side, locale-fixed en). */
export function formatAttribute(value: unknown, unit?: string): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "number") {
    // Group only when a unit is shown — bare numbers like `year` must read
    // "2020", not "2,020".
    const n = unit ? value.toLocaleString("en-US") : String(value);
    return unit ? `${n} ${unit}` : n;
  }
  return unit ? `${String(value)} ${unit}` : String(value);
}

/**
 * ISO "YYYY-MM-DD" attribute (inputType:"date" on the attribute def) rendered
 * as a medium date ("Oct 1, 2026"). Unparseable values fall back to the raw
 * string rather than "Invalid Date" (QA-216).
 */
export function formatAttributeDate(value: unknown, locale = "en"): string {
  const s = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(d);
}
