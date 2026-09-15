/**
 * Money is always handled in minor units (cents) as integers — never floats.
 */

export type Currency = "USD" | "EUR" | "CHF" | "GBP" | (string & {});

/** ISO-4217 minor unit digits for the currencies we deal with. */
const MINOR_UNIT_DIGITS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  CHF: 2,
  GBP: 2,
  AED: 2,
  JPY: 0,
};

export function minorUnitDigits(currency: Currency): number {
  return MINOR_UNIT_DIGITS[currency] ?? 2;
}

/** "199.00" / 199 / 199.0 -> 19900 */
export function toMinorUnits(amount: number, currency: Currency): number {
  const digits = minorUnitDigits(currency);
  return Math.round(amount * 10 ** digits);
}

export function fromMinorUnits(minor: number, currency: Currency): number {
  const digits = minorUnitDigits(currency);
  return minor / 10 ** digits;
}

/**
 * `pct` is a percentage like 3 or 1.5. Computes in basis points to avoid
 * float error, rounds half-up to the nearest minor unit.
 */
export function percentOf(minor: number, pct: number): number {
  const basisPoints = Math.round(pct * 100);
  return Math.round((minor * basisPoints) / 10_000);
}
