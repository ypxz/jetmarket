/**
 * Coarse airport -> region buckets used by RFQ matching. Region equality is a
 * soft ranking signal, not a hard filter — "same region" means same bucket.
 * Covers the airports in the jets seed (ZRH/GVA/NCE/LTN) plus major business-
 * aviation fields; unknown airports fall back to `OTHER`.
 */

export const AIRPORT_REGION: Record<string, string> = {
  // Switzerland
  ZRH: "CH", LSZH: "CH", GVA: "CH", LSGG: "CH", BSL: "CH", EAP: "CH",
  BRN: "CH", LUG: "CH",
  // France
  NCE: "FR", LFMN: "FR", CDG: "FR", LFPB: "FR", ORY: "FR", LBG: "FR",
  LYS: "FR", MRS: "FR", TLS: "FR", BOD: "FR",
  // United Kingdom
  LTN: "GB", EGGW: "GB", LHR: "GB", EGLL: "GB", FAB: "GB", EGLF: "GB",
  STN: "GB", BQH: "GB", MAN: "GB", EDI: "GB",
  // Germany
  FRA: "DE", EDDF: "DE", MUC: "DE", EDDM: "DE", TXL: "DE", BER: "DE",
  HAM: "DE", DUS: "DE", CGN: "DE", STR: "DE",
  // Italy / Spain / Portugal
  MXP: "IT", LIMC: "IT", LIN: "IT", FCO: "IT", CIA: "IT", VCE: "IT",
  NAP: "IT", MAD: "ES", LEMD: "ES", BCN: "ES", LEBL: "ES", IBZ: "ES",
  PMI: "ES", LIS: "PT", LPPT: "PT", OPO: "PT", FAO: "PT",
  // Austria / Benelux / Nordics
  VIE: "AT", LOWW: "AT", SZG: "AT", BRU: "BE", EBBR: "BE", AMS: "NL",
  EHAM: "NL", RTM: "NL", LUX: "LU", CPH: "DK", OSL: "NO", ARN: "SE",
  // Greece / Croatia / CEE
  ATH: "GR", LGAV: "GR", DBV: "HR", PRG: "CZ", WAW: "PL", BUD: "HU",
  // Middle East / US majors
  DXB: "AE", OMDW: "AE", DOH: "QA", RUH: "SA",
  TEB: "US-E", HPN: "US-E", JFK: "US-E", BOS: "US-E", MIA: "US-E",
  VNY: "US-W", LAX: "US-W", SFO: "US-W", LAS: "US-W",
};

export const OTHER_REGION = "OTHER";

export function regionOfAirport(
  code: string | null | undefined,
  map: Record<string, string> = AIRPORT_REGION,
): string {
  if (!code) return OTHER_REGION;
  return map[code.toUpperCase()] ?? OTHER_REGION;
}

export function sameRegion(
  a: string | null | undefined,
  b: string | null | undefined,
  map: Record<string, string> = AIRPORT_REGION,
): boolean {
  const ra = regionOfAirport(a, map);
  const rb = regionOfAirport(b, map);
  if (ra === OTHER_REGION || rb === OTHER_REGION) return false;
  return ra === rb;
}
