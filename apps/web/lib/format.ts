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
    const n = value.toLocaleString("en-US");
    return unit ? `${n} ${unit}` : n;
  }
  return unit ? `${String(value)} ${unit}` : String(value);
}
