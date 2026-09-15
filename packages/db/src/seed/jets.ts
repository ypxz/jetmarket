/**
 * Idempotent jets seed (spec: synthetic but realistic — no scraped data).
 * 15 operators / 60 listings incl. empty legs on ZRH/GVA/NCE/LTN. Deterministic
 * UUIDs + upserts make re-runs converge; photo placeholders are written to
 * STORAGE_DIR so the storage mock can serve them.
 *
 * Row ids: 00000000-0000-4000-8000-<12-digit counter> — users 1–15,
 * operators 101–115, listings 200–259.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "../client";
import { listings, operators, users } from "../schema";
import type { NewListing, NewOperator, NewUser } from "../schema";

const uid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Category = "light" | "midsize" | "heavy" | "ultra_long_range";

interface Aircraft {
  category: Category;
  model: string;
  year: number;
  seats: number;
  rangeNm: number;
  /** Indicative charter rate, USD/hr. */
  hourlyUsd: number;
  /** Ask price for sale listings, USD. */
  askUsd?: number;
  totalTimeHours?: number;
}

const FLEET = {
  phenom300: { category: "light", model: "Embraer Phenom 300E", year: 2021, seats: 7, rangeNm: 2010, hourlyUsd: 4300, askUsd: 9_800_000, totalTimeHours: 640 },
  cj4: { category: "light", model: "Cessna Citation CJ4 Gen2", year: 2022, seats: 8, rangeNm: 2165, hourlyUsd: 4400, askUsd: 11_200_000, totalTimeHours: 380 },
  pc24: { category: "light", model: "Pilatus PC-24", year: 2020, seats: 8, rangeNm: 2000, hourlyUsd: 4900, askUsd: 10_500_000, totalTimeHours: 890 },
  learjet75: { category: "light", model: "Learjet 75 Liberty", year: 2019, seats: 8, rangeNm: 2040, hourlyUsd: 4100 },
  m2: { category: "light", model: "Cessna Citation M2 Gen2", year: 2023, seats: 6, rangeNm: 1550, hourlyUsd: 3400 },
  hondajet: { category: "light", model: "HondaJet Elite II", year: 2022, seats: 6, rangeNm: 1437, hourlyUsd: 3200 },
  xls: { category: "midsize", model: "Cessna Citation XLS+", year: 2018, seats: 8, rangeNm: 2100, hourlyUsd: 5300, askUsd: 7_900_000, totalTimeHours: 2100 },
  praetor600: { category: "midsize", model: "Embraer Praetor 600", year: 2021, seats: 9, rangeNm: 4018, hourlyUsd: 7200, askUsd: 20_500_000, totalTimeHours: 720 },
  learjet60: { category: "midsize", model: "Learjet 60XR", year: 2012, seats: 7, rangeNm: 2405, hourlyUsd: 4600, askUsd: 3_400_000, totalTimeHours: 4800 },
  hawker900: { category: "midsize", model: "Hawker 900XP", year: 2011, seats: 8, rangeNm: 2800, hourlyUsd: 4800, askUsd: 4_100_000, totalTimeHours: 5300 },
  challenger350: { category: "heavy", model: "Bombardier Challenger 350", year: 2020, seats: 10, rangeNm: 3200, hourlyUsd: 8900, askUsd: 23_000_000, totalTimeHours: 1150 },
  falcon2000: { category: "heavy", model: "Dassault Falcon 2000LXS", year: 2019, seats: 10, rangeNm: 4000, hourlyUsd: 9800, askUsd: 27_500_000, totalTimeHours: 1600 },
  legacy650: { category: "heavy", model: "Embraer Legacy 650E", year: 2017, seats: 13, rangeNm: 3900, hourlyUsd: 8400, askUsd: 14_900_000, totalTimeHours: 2900 },
  g280: { category: "heavy", model: "Gulfstream G280", year: 2020, seats: 10, rangeNm: 3600, hourlyUsd: 9200 },
  challenger650: { category: "heavy", model: "Bombardier Challenger 650", year: 2021, seats: 12, rangeNm: 4000, hourlyUsd: 9900, askUsd: 31_000_000, totalTimeHours: 950 },
  g650: { category: "ultra_long_range", model: "Gulfstream G650ER", year: 2019, seats: 16, rangeNm: 7500, hourlyUsd: 14500, askUsd: 42_000_000, totalTimeHours: 1800 },
  global7500: { category: "ultra_long_range", model: "Bombardier Global 7500", year: 2022, seats: 17, rangeNm: 7700, hourlyUsd: 15900, askUsd: 73_000_000, totalTimeHours: 410 },
  falcon8x: { category: "ultra_long_range", model: "Dassault Falcon 8X", year: 2018, seats: 14, rangeNm: 6450, hourlyUsd: 13800, askUsd: 38_500_000, totalTimeHours: 2400 },
  global6500: { category: "ultra_long_range", model: "Bombardier Global 6500", year: 2021, seats: 15, rangeNm: 6600, hourlyUsd: 14200 },
} satisfies Record<string, Aircraft>;

interface OperatorSeed {
  n: number; // deterministic id counter offset
  slug: string;
  name: string;
  email: string;
  baseAirport: string;
  verified: boolean;
  plan: "free" | "pro";
  fleetSummary: string;
  fleet: (keyof typeof FLEET)[];
}

const OPERATORS: OperatorSeed[] = [
  { n: 101, slug: "alpine-jet", name: "Alpine Jet AG", email: "ops@alpinejet.example", baseAirport: "ZRH", verified: true, plan: "pro", fleetSummary: "Zurich-based light and super-midsize fleet for European point-to-point charter.", fleet: ["pc24", "phenom300", "challenger350"] },
  { n: 102, slug: "geneva-executive", name: "Geneva Executive Aviation", email: "charter@gvaexec.example", baseAirport: "GVA", verified: true, plan: "pro", fleetSummary: "Geneva long-range specialist — Falcon and Gulfstream aircraft for intercontinental trips.", fleet: ["xls", "g650"] },
  { n: 103, slug: "riviera-wings", name: "Riviera Wings", email: "ops@rivierawings.example", baseAirport: "NCE", verified: true, plan: "pro", fleetSummary: "Côte d'Azur operator covering the Riviera, Alps and London shuttle markets.", fleet: ["phenom300", "praetor600"] },
  { n: 104, slug: "london-jet-centre", name: "London Jet Centre", email: "sales@londonjetcentre.example", baseAirport: "LTN", verified: true, plan: "pro", fleetSummary: "Luton-based heavy and ultra-long-range fleet; frequent London–Nice capacity.", fleet: ["falcon2000", "global7500"] },
  { n: 105, slug: "swiss-aircharter", name: "Swiss AirCharter", email: "fly@swissaircharter.example", baseAirport: "ZRH", verified: true, plan: "free", fleetSummary: "Single-aircraft light-jet operator focused on domestic and Alpine hops.", fleet: ["cj4"] },
  { n: 106, slug: "cote-dazur-aviation", name: "Côte d'Azur Aviation", email: "ops@cdaaviation.example", baseAirport: "NCE", verified: true, plan: "free", fleetSummary: "Nice midsize charter with seasonal Mediterranean positioning.", fleet: ["hawker900"] },
  { n: 107, slug: "helvetic-skyways", name: "Helvetic Skyways", email: "info@helveticsky.example", baseAirport: "BSL", verified: false, plan: "free", fleetSummary: "Basel light-jet startup serving the tri-border region.", fleet: ["learjet75"] },
  { n: 108, slug: "alpenair", name: "AlpenAir Charter", email: "ops@alpenair.example", baseAirport: "BRN", verified: false, plan: "free", fleetSummary: "Bern-based single M2 for short European hops.", fleet: ["m2"] },
  { n: 109, slug: "thames-executive", name: "Thames Executive", email: "desk@thamesexec.example", baseAirport: "FAB", verified: true, plan: "free", fleetSummary: "Farnborough midsize operator, strong on UK–Continent shuttle routes.", fleet: ["learjet60"] },
  { n: 110, slug: "cote-air", name: "Côte Air Services", email: "ops@coteair.example", baseAirport: "LYS", verified: false, plan: "free", fleetSummary: "Lyon HondaJet operator; light, fast, economical.", fleet: ["hondajet"] },
  { n: 111, slug: "milano-jet", name: "Milano Jet", email: "charter@milanojet.example", baseAirport: "MXP", verified: true, plan: "free", fleetSummary: "Malpensa heavy jet covering Italy, the Med and Alpine resorts.", fleet: ["legacy650"] },
  { n: 112, slug: "bavarian-wings", name: "Bavarian Wings", email: "ops@bavarianwings.example", baseAirport: "MUC", verified: false, plan: "free", fleetSummary: "Munich midsize charter for DACH business aviation.", fleet: ["xls"] },
  { n: 113, slug: "idf-jets", name: "Île-de-France Jets", email: "ops@idfjets.example", baseAirport: "LBG", verified: true, plan: "pro", fleetSummary: "Paris-Le Bourget heavy and ultra-long-range fleet.", fleet: ["challenger650", "global6500"] },
  { n: 114, slug: "nordlicht", name: "Nordlicht Aviation", email: "ops@nordlicht.example", baseAirport: "HAM", verified: false, plan: "free", fleetSummary: "Hamburg midsize operator covering Northern Europe.", fleet: ["hawker900"] },
  { n: 115, slug: "iberia-charter", name: "Iberia Charter Partners", email: "ops@iberiacharter.example", baseAirport: "MAD", verified: false, plan: "free", fleetSummary: "Madrid light-jet operator for Iberian and Canaries sectors.", fleet: ["phenom300"] },
];

/** Empty legs keyed to real aircraft; dates are today+offset. */
interface EmptyLegSeed {
  op: string; // operator slug
  aircraft: keyof typeof FLEET;
  from: string;
  to: string;
  dayOffset: number;
  priceUsd: number;
}

const EMPTY_LEGS: EmptyLegSeed[] = [
  { op: "alpine-jet", aircraft: "pc24", from: "ZRH", to: "NCE", dayOffset: 3, priceUsd: 5900 },
  { op: "alpine-jet", aircraft: "phenom300", from: "ZRH", to: "LTN", dayOffset: 6, priceUsd: 7400 },
  { op: "alpine-jet", aircraft: "challenger350", from: "GVA", to: "NCE", dayOffset: 9, priceUsd: 8200 },
  { op: "alpine-jet", aircraft: "pc24", from: "NCE", to: "ZRH", dayOffset: 12, priceUsd: 6100 },
  { op: "geneva-executive", aircraft: "xls", from: "GVA", to: "LTN", dayOffset: 2, priceUsd: 7900 },
  { op: "geneva-executive", aircraft: "g650", from: "GVA", to: "TEB", dayOffset: 5, priceUsd: 58000 },
  { op: "geneva-executive", aircraft: "xls", from: "LTN", to: "GVA", dayOffset: 8, priceUsd: 7600 },
  { op: "geneva-executive", aircraft: "xls", from: "GVA", to: "NCE", dayOffset: 11, priceUsd: 6200 },
  { op: "riviera-wings", aircraft: "phenom300", from: "NCE", to: "ZRH", dayOffset: 1, priceUsd: 5700 },
  { op: "riviera-wings", aircraft: "praetor600", from: "NCE", to: "LTN", dayOffset: 4, priceUsd: 9400 },
  { op: "riviera-wings", aircraft: "phenom300", from: "NCE", to: "GVA", dayOffset: 7, priceUsd: 5200 },
  { op: "riviera-wings", aircraft: "praetor600", from: "LTN", to: "NCE", dayOffset: 10, priceUsd: 9700 },
  { op: "riviera-wings", aircraft: "phenom300", from: "NCE", to: "IBZ", dayOffset: 14, priceUsd: 6600 },
  { op: "london-jet-centre", aircraft: "falcon2000", from: "LTN", to: "NCE", dayOffset: 2, priceUsd: 12900 },
  { op: "london-jet-centre", aircraft: "falcon2000", from: "NCE", to: "LTN", dayOffset: 13, priceUsd: 12400 },
  { op: "london-jet-centre", aircraft: "falcon2000", from: "LTN", to: "ZRH", dayOffset: 17, priceUsd: 11200 },
  { op: "swiss-aircharter", aircraft: "cj4", from: "ZRH", to: "GVA", dayOffset: 4, priceUsd: 3900 },
  { op: "swiss-aircharter", aircraft: "cj4", from: "ZRH", to: "NCE", dayOffset: 19, priceUsd: 6800 },
  { op: "cote-dazur-aviation", aircraft: "hawker900", from: "NCE", to: "LBG", dayOffset: 5, priceUsd: 8600 },
  { op: "alpenair", aircraft: "m2", from: "BRN", to: "NCE", dayOffset: 6, priceUsd: 4400 },
  { op: "thames-executive", aircraft: "learjet60", from: "FAB", to: "NCE", dayOffset: 3, priceUsd: 6800 },
  { op: "thames-executive", aircraft: "learjet60", from: "FAB", to: "GVA", dayOffset: 12, priceUsd: 6200 },
  { op: "milano-jet", aircraft: "legacy650", from: "MXP", to: "LTN", dayOffset: 7, priceUsd: 11800 },
  { op: "bavarian-wings", aircraft: "xls", from: "MUC", to: "ZRH", dayOffset: 10, priceUsd: 4900 },
  { op: "idf-jets", aircraft: "challenger650", from: "LBG", to: "NCE", dayOffset: 1, priceUsd: 11400 },
  { op: "nordlicht", aircraft: "hawker900", from: "HAM", to: "LTN", dayOffset: 11, priceUsd: 7100 },
  { op: "iberia-charter", aircraft: "phenom300", from: "MAD", to: "NCE", dayOffset: 15, priceUsd: 8100 },
];

/** Aircraft-for-sale listings. */
const SALES: { op: string; aircraft: keyof typeof FLEET; askUsd: number; hours: number }[] = [
  { op: "alpine-jet", aircraft: "phenom300", askUsd: 9_800_000, hours: 640 },
  { op: "alpine-jet", aircraft: "challenger350", askUsd: 23_000_000, hours: 1150 },
  { op: "geneva-executive", aircraft: "xls", askUsd: 7_900_000, hours: 2100 },
  { op: "geneva-executive", aircraft: "g650", askUsd: 42_000_000, hours: 1800 },
  { op: "london-jet-centre", aircraft: "falcon2000", askUsd: 27_500_000, hours: 1600 },
  { op: "london-jet-centre", aircraft: "global7500", askUsd: 73_000_000, hours: 410 },
  { op: "riviera-wings", aircraft: "praetor600", askUsd: 20_500_000, hours: 720 },
  { op: "thames-executive", aircraft: "learjet60", askUsd: 3_400_000, hours: 4800 },
  { op: "milano-jet", aircraft: "legacy650", askUsd: 14_900_000, hours: 2900 },
  { op: "idf-jets", aircraft: "challenger650", askUsd: 31_000_000, hours: 950 },
  { op: "swiss-aircharter", aircraft: "cj4", askUsd: 11_200_000, hours: 380 },
  { op: "cote-dazur-aviation", aircraft: "hawker900", askUsd: 4_100_000, hours: 5300 },
];

function isoDateIn(days: number, from = new Date()): string {
  const d = new Date(from.getTime() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function photoKey(opSlug: string, listingN: number, photo: number): string {
  return `seed/${opSlug}/l${listingN}-p${photo}.svg`;
}

function photoSvg(title: string, variant: number): string {
  const hues = [215, 200, 190, 35, 160, 280];
  const h = hues[variant % hues.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <rect width="800" height="450" fill="hsl(${h},45%,18%)"/>
  <path d="M120 300 L400 180 L680 300" stroke="hsl(${h},60%,70%)" stroke-width="6" fill="none"/>
  <circle cx="400" cy="180" r="14" fill="hsl(${h},60%,70%)"/>
  <text x="400" y="360" font-family="system-ui" font-size="28" fill="hsl(${h},30%,85%)" text-anchor="middle">${title}</text>
</svg>`;
}

export interface JetsSeedData {
  userRows: NewUser[];
  opRows: NewOperator[];
  listingRows: NewListing[];
}

/**
 * Pure builder — split out so unit tests can validate generated rows against
 * the real vertical config without a database.
 */
export function buildJetsSeed(now = new Date()): JetsSeedData {
  const userRows: NewUser[] = OPERATORS.map((o, i) => ({
    id: uid(i + 1),
    email: o.email,
    role: "operator",
  }));
  const opRows: NewOperator[] = OPERATORS.map((o) => ({
    id: uid(o.n),
    userId: uid(o.n - 100),
    name: o.name,
    baseAirport: o.baseAirport,
    fleetSummary: o.fleetSummary,
    verified: o.verified,
    plan: o.plan,
  }));

  const listingRows: NewListing[] = [];
  let n = 200;
  const opBySlug = new Map(OPERATORS.map((o) => [o.slug, o]));

  for (const o of OPERATORS) {
    for (const key of o.fleet) {
      const a = FLEET[key];
      listingRows.push({
        id: uid(n),
        operatorId: uid(o.n),
        vertical: "jets",
        type: "charter",
        title: `${a.model} — charter from ${o.baseAirport}`,
        attributes: {
          aircraftCategory: a.category,
          aircraftModel: a.model,
          yearOfManufacture: a.year,
          seats: a.seats,
          rangeNm: a.rangeNm,
          baseIcao: o.baseAirport,
        },
        priceMinor: Math.round(a.hourlyUsd * 100),
        currency: "USD",
        status: "active",
        photos: [0, 1].map((p) => photoKey(o.slug, n, p)),
      });
      n += 1;
    }
  }

  for (const leg of EMPTY_LEGS) {
    const o = opBySlug.get(leg.op)!;
    const a = FLEET[leg.aircraft];
    listingRows.push({
      id: uid(n),
      operatorId: uid(o.n),
      vertical: "jets",
      type: "empty_leg",
      title: `${leg.from} → ${leg.to} empty leg — ${a.model}`,
      attributes: {
        aircraftCategory: a.category,
        aircraftModel: a.model,
        yearOfManufacture: a.year,
        seats: a.seats,
        departureIcao: leg.from,
        arrivalIcao: leg.to,
        departureDate: isoDateIn(leg.dayOffset, now),
        priceUsd: leg.priceUsd,
      },
      priceMinor: Math.round(leg.priceUsd * 100),
      currency: "USD",
      status: "active",
      photos: [photoKey(o.slug, n, 0)],
    });
    n += 1;
  }

  for (const s of SALES) {
    const o = opBySlug.get(s.op)!;
    const a = FLEET[s.aircraft];
    listingRows.push({
      id: uid(n),
      operatorId: uid(o.n),
      vertical: "jets",
      type: "aircraft_sale",
      title: `${a.year} ${a.model} for sale`,
      attributes: {
        aircraftCategory: a.category,
        aircraftModel: a.model,
        yearOfManufacture: a.year,
        seats: a.seats,
        rangeNm: a.rangeNm,
        totalTimeHours: s.hours,
        priceUsd: s.askUsd,
      },
      priceMinor: Math.round(s.askUsd * 100),
      currency: "USD",
      status: "active",
      photos: [0, 1, 2].map((p) => photoKey(o.slug, n, p)),
    });
    n += 1;
  }

  const listingTotal = n - 200;
  if (listingTotal !== JETS_SEED_COUNTS.listings) {
    throw new Error(
      `seed generated ${listingTotal} listings, expected ${JETS_SEED_COUNTS.listings}`,
    );
  }
  return { userRows, opRows, listingRows };
}

export interface SeedResult {
  users: number;
  operators: number;
  listings: number;
  photos: number;
}

export const JETS_SEED_COUNTS = { operators: 15, listings: 60 } as const;

/**
 * Seed users + operators + listings + photo files. Idempotent via upserts on
 * deterministic ids; re-running updates rows in place.
 */
export async function seedJets(
  db: Db,
  opts: { storageDir?: string; now?: Date } = {},
): Promise<SeedResult> {
  const now = opts.now ?? new Date();
  const storageDir = opts.storageDir ?? process.env.STORAGE_DIR ?? "./storage";
  const { userRows, opRows, listingRows } = buildJetsSeed(now);

  // Photo placeholders on the storage mock's filesystem.
  let photos = 0;
  for (const l of listingRows) {
    for (const [i, key] of (l.photos ?? []).entries()) {
      const path = join(storageDir, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, photoSvg(l.title, i + l.title.length));
      photos += 1;
    }
  }

  await db.transaction(async (tx) => {
    for (const row of userRows) {
      await tx
        .insert(users)
        .values(row)
        .onConflictDoUpdate({
          target: users.id,
          set: { email: row.email, role: row.role },
        });
    }
    for (const row of opRows) {
      await tx
        .insert(operators)
        .values(row)
        .onConflictDoUpdate({
          target: operators.id,
          set: {
            name: row.name,
            baseAirport: row.baseAirport,
            fleetSummary: row.fleetSummary,
            verified: row.verified,
            plan: row.plan,
          },
        });
    }
    for (const row of listingRows) {
      await tx
        .insert(listings)
        .values(row)
        .onConflictDoUpdate({
          target: listings.id,
          set: {
            type: row.type,
            title: row.title,
            attributes: row.attributes,
            priceMinor: row.priceMinor,
            currency: row.currency,
            status: row.status,
            photos: row.photos,
            updatedAt: now,
          },
        });
    }
  });

  return {
    users: userRows.length,
    operators: opRows.length,
    listings: listingRows.length,
    photos,
  };
}
