/**
 * RFQ -> operator matching (spec core loop + T13).
 *
 * A buyer RFQ matches the listing's own operator (handled by the caller) plus
 * N other operators whose fleet fits. Fit is computed from normalized
 * requirements extracted from rfq.fields and each operator's fleet entries;
 * verified + paid-plan operators get the RFQ instantly, everyone else is
 * delayed (plans.rfqDeliveryDelayMinutes).
 *
 * Field conventions (documented for vertical authors): rfq.fields may carry
 * `category`/`aircraftCategory`, `seats`/`pax`/`passengers`, `departure`/
 * `from`, `arrival`/`to`. Listing attributes may carry `category`, `seats`.
 */
import { regionOfAirport, sameRegion, AIRPORT_REGION } from "./geo";
import { deliveryFor, rfqDeliveryDelayMinutes } from "./plans";
import type { Plan } from "./vertical-config";

export interface MatchRequirements {
  /** Aircraft category requested, e.g. "light" | "mid" | "heavy" | "ultra-long". */
  category?: string;
  /** Minimum seats required. */
  seats?: number;
  /** Departure airport code (IATA/ICAO). */
  departure?: string;
  /** Arrival airport code. */
  arrival?: string;
}

export interface FleetEntry {
  /** e.g. "light". Undefined = category unknown. */
  category?: string;
  /** Certified seats for this airframe/listing. */
  seats?: number;
  /** Listing id this entry came from — kept so matches can cite it. */
  listingId?: string;
}

export interface OperatorCandidate {
  id: string;
  verified: boolean;
  planId: string;
  baseAirport?: string | null;
  fleet: FleetEntry[];
}

export interface MatchResult {
  operatorId: string;
  /** Best-fitting listing for context, when the entry carried one. */
  listingId: string | null;
  score: number;
  delivery: "instant" | "delayed";
  delayMinutes: number;
}

const CATEGORY_KEYS = ["category", "aircraftCategory"] as const;
const SEAT_KEYS = ["seats", "pax", "passengers"] as const;
const DEPARTURE_KEYS = ["departure", "from", "origin"] as const;
const ARRIVAL_KEYS = ["arrival", "to", "destination"] as const;

function firstString(
  fields: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function firstNumber(
  fields: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return undefined;
}

/** Default extractor for the documented RFQ field names. */
export function defaultRequirementExtractor(
  fields: Record<string, unknown>,
): MatchRequirements {
  const category = firstString(fields, CATEGORY_KEYS);
  const seats = firstNumber(fields, SEAT_KEYS);
  const departure = firstString(fields, DEPARTURE_KEYS);
  const arrival = firstString(fields, ARRIVAL_KEYS);
  return {
    ...(category ? { category: category.toLowerCase() } : {}),
    ...(seats !== undefined ? { seats } : {}),
    ...(departure ? { departure: departure.toUpperCase() } : {}),
    ...(arrival ? { arrival: arrival.toUpperCase() } : {}),
  };
}

export interface MatchOptions {
  /** Extract requirements from rfq.fields. Defaults to the conventions above. */
  extract?: (fields: Record<string, unknown>) => MatchRequirements;
  /** Airport -> region map override (defaults to built-in). */
  regionMap?: Record<string, string>;
  /** Max matches returned. Default 10; the listing's own operator is excluded
   * by the caller before calling. */
  limit?: number;
  /** Operators to exclude entirely (e.g. already matched via the listing). */
  excludeOperatorIds?: ReadonlySet<string>;
}

interface RankedEntry {
  entry: FleetEntry;
  score: number;
}

/**
 * Fleet fit: when the RFQ names a category, at least one fleet entry must
 * match it (an operator with no declared category entries cannot prove fit
 * and is skipped). Seat requirements are hard-filtered against the matching
 * entry's seats; an entry without seat data still fits (unknown ≠ disproven).
 */
function bestFit(
  candidate: OperatorCandidate,
  req: MatchRequirements,
  regionMap: Record<string, string>,
): RankedEntry | null {
  let best: RankedEntry | null = null;
  const considered =
    candidate.fleet.length > 0 ? candidate.fleet : [{}];

  for (const entry of considered) {
    if (
      req.category &&
      (!entry.category || entry.category.toLowerCase() !== req.category)
    ) {
      continue;
    }
    if (
      req.seats !== undefined &&
      entry.seats !== undefined &&
      entry.seats < req.seats
    ) {
      continue;
    }
    let score = 0;
    if (req.category && entry.category) score += 2;
    if (req.seats !== undefined && entry.seats !== undefined) score += 1;
    if (
      candidate.baseAirport &&
      sameRegion(candidate.baseAirport, req.departure, regionMap)
    ) {
      score += 1;
    }
    if (!best || score > best.score) best = { entry, score };
  }

  // Category was required but no entry matched -> cannot prove fit.
  if (
    req.category &&
    candidate.fleet.every(
      (e) => !e.category || e.category.toLowerCase() !== req.category,
    )
  ) {
    return null;
  }
  return best;
}

export function matchOperators(
  rfqFields: Record<string, unknown>,
  candidates: OperatorCandidate[],
  plans: Plan[],
  options: MatchOptions = {},
): MatchResult[] {
  const req = (options.extract ?? defaultRequirementExtractor)(rfqFields);
  const regionMap = options.regionMap ?? AIRPORT_REGION;
  const limit = options.limit ?? 10;
  const results: MatchResult[] = [];

  for (const c of candidates) {
    if (options.excludeOperatorIds?.has(c.id)) continue;
    const fit = bestFit(c, req, regionMap);
    if (!fit) continue;
    // Unknown plan ids fall back to a no-delay plan; unverified operators are
    // still delayed via UNVERIFIED_RFQ_DELAY_MINUTES.
    const plan: Plan = plans.find((p) => p.id === c.planId) ?? {
      id: c.planId,
      name: c.planId,
      priceMinor: 0,
      currency: "USD",
      maxListings: null,
      rfqDelayMinutes: 0,
    };
    const delayMinutes = rfqDeliveryDelayMinutes(plan, c.verified);
    results.push({
      operatorId: c.id,
      listingId: fit.entry.listingId ?? null,
      score: fit.score + (c.verified ? 1 : 0),
      delivery: deliveryFor(plan, c.verified),
      delayMinutes,
    });
  }

  results.sort((a, b) => b.score - a.score || a.operatorId.localeCompare(b.operatorId));
  return results.slice(0, limit);
}

/**
 * When a delayed match becomes deliverable, given a match computed `at`.
 */
export function deliverAt(match: MatchResult, at: Date): Date {
  return new Date(at.getTime() + match.delayMinutes * 60_000);
}

export { regionOfAirport };
