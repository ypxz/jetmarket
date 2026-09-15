/**
 * Success-fee math. Rates come from VerticalConfig.fees.successFeePct —
 * for jets: 3% charter / 3% empty_leg / 1.5% aircraft_sale.
 */
import { percentOf } from "./money";
import type { VerticalConfig } from "./vertical-config";

export function successFeePctFor(
  config: Pick<VerticalConfig, "fees">,
  listingType: string,
): number {
  const pct = config.fees.successFeePct[listingType];
  if (pct === undefined) {
    throw new Error(`no success fee configured for listing type "${listingType}"`);
  }
  return pct;
}

/** feeMinor = round(amountMinor * pct / 100), basis-point math. */
export function successFeeAmount(amountMinor: number, pct: number): number {
  if (amountMinor < 0 || !Number.isFinite(amountMinor)) {
    throw new Error("amountMinor must be a non-negative finite number");
  }
  return percentOf(amountMinor, pct);
}
