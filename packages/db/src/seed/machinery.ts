/**
 * Idempotent machinery seed — same shape as the jets seed, for the second
 * vertical (spec: machinery = config-folder scaffold; this proves the data
 * layer works unchanged). 8 dealers / 24 listings across for_sale, for_rent,
 * auction. Deterministic UUIDs + upserts; photos land in the storage mock's
 * dir.
 *
 * Row ids continue the shared counter space — users 1001–1008,
 * operators 1101–1108, listings 1200–1223 — so both seeds coexist in one db.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../client";
import { listings, operators, users } from "../schema";
import type { NewListing, NewOperator, NewUser } from "../schema";

const uid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Category =
  | "cnc_milling"
  | "lathe"
  | "press"
  | "conveyor"
  | "forklift"
  | "generator";

interface Machine {
  category: Category;
  make: string;
  model: string;
  year: number;
  hours?: number;
  weightKg?: number;
  /** Ask price EUR for sale/auction. */
  askEur?: number;
  /** Monthly rent EUR for rent listings. */
  rentEur?: number;
}

const MACHINES: Record<string, Machine> = {
  dmgMori: { category: "cnc_milling", make: "DMG Mori", model: "DMU 50 3rd Gen", year: 2021, hours: 4200, weightKg: 6500, askEur: 385_000 },
  haasVf2: { category: "cnc_milling", make: "Haas", model: "VF-2SS", year: 2019, hours: 9800, weightKg: 3800, askEur: 62_000 },
  mazakQtn: { category: "lathe", make: "Mazak", model: "QTN-250MSY", year: 2020, hours: 7600, weightKg: 6100, askEur: 148_000 },
  okumaLb: { category: "lathe", make: "Okuma", model: "LB3000 EX II", year: 2018, hours: 12400, weightKg: 5800, askEur: 96_000 },
  trumpfPress: { category: "press", make: "TRUMPF", model: "TruPunch 3000", year: 2022, hours: 2100, weightKg: 11000, askEur: 410_000 },
  schuler: { category: "press", make: "Schuler", model: "MSP 400", year: 2015, hours: 32000, weightKg: 24000, askEur: 175_000 },
  demagConv: { category: "conveyor", make: "Dematic", model: "Modular Belt 24m", year: 2021, weightKg: 2400, rentEur: 2900 },
  interroll: { category: "conveyor", make: "Interroll", model: "RollerDrive line 12m", year: 2023, weightKg: 950, rentEur: 1350 },
  linde39x: { category: "forklift", make: "Linde", model: "E25 EVO", year: 2022, hours: 1800, weightKg: 4200, askEur: 31_500, rentEur: 890 },
  toyota8f: { category: "forklift", make: "Toyota", model: "8FBMT30", year: 2019, hours: 5400, weightKg: 4900, askEur: 18_900, rentEur: 640 },
  atlasGen: { category: "generator", make: "Atlas Copco", model: "QAS 150", year: 2020, hours: 3900, weightKg: 3500, askEur: 28_500, rentEur: 1150 },
  catDe88: { category: "generator", make: "Caterpillar", model: "DE88E0", year: 2021, hours: 1200, weightKg: 2600, askEur: 41_000, rentEur: 1450 },
  hermleC42: { category: "cnc_milling", make: "Hermle", model: "C 42 U", year: 2023, hours: 900, weightKg: 9200, askEur: 520_000 },
  doosanPuma: { category: "lathe", make: "DN Solutions", model: "PUMA 2600Y", year: 2022, hours: 3100, weightKg: 6800, askEur: 165_000 },
  hyster: { category: "forklift", make: "Hyster", model: "J3.5XN", year: 2018, hours: 8900, weightKg: 5400, askEur: 14_500 },
  fischer: { category: "press", make: "Fischer", model: "HFP-100", year: 2017, hours: 21000, weightKg: 8900, rentEur: 3200 },
};

interface DealerSeed {
  n: number;
  slug: string;
  name: string;
  email: string;
  /** Operator.location — the shared column is named baseAirport; for
   *  machinery it carries the dealer's home city/country. */
  base: string;
  verified: boolean;
  plan: "free" | "pro";
  summary: string;
  stock: (keyof typeof MACHINES)[];
}

const DEALERS: DealerSeed[] = [
  { n: 1101, slug: "alpine-werkzeug", name: "Alpine Werkzeugmaschinen AG", email: "sales@alpinewerk.example", base: "Zürich, CH", verified: true, plan: "pro", summary: "Swiss CNC dealer — milling and turning centres with service history.", stock: ["dmgMori", "hermleC42", "mazakQtn"] },
  { n: 1102, slug: "rhein-maschinen", name: "Rhein Maschinenhandel", email: "kontakt@rheinmaschinen.example", base: "Düsseldorf, DE", verified: true, plan: "pro", summary: "NRW press and forming specialist; auction consignments welcome.", stock: ["trumpfPress", "schuler", "fischer"] },
  { n: 1103, slug: "nord-foerdertechnik", name: "Nord Fördertechnik", email: "info@nordfoerder.example", base: "Hamburg, DE", verified: true, plan: "free", summary: "Conveyor systems and intralogistics lines, rent or buy.", stock: ["demagConv", "interroll"] },
  { n: 1104, slug: "ibérica-maquinaria", name: "Ibérica Maquinaria", email: "ventas@ibericamaq.example", base: "Bilbao, ES", verified: true, plan: "free", summary: "Lathes and milling for Iberian workshops.", stock: ["okumaLb", "doosanPuma"] },
  { n: 1105, slug: "lowlands-forklifts", name: "Lowlands Forklifts", email: "hire@lowlandsfl.example", base: "Rotterdam, NL", verified: false, plan: "free", summary: "Electric forklift sales and rental across Benelux ports.", stock: ["linde39x", "toyota8f", "hyster"] },
  { n: 1106, slug: "weser-power", name: "Weser Power Systems", email: "miete@weserpower.example", base: "Bremen, DE", verified: true, plan: "free", summary: "Standby and prime-power generators, tested under load.", stock: ["atlasGen", "catDe88"] },
  { n: 1107, slug: "piemonte-macchine", name: "Piemonte Macchine Utensili", email: "vendite@piemontemacchine.example", base: "Torino, IT", verified: false, plan: "free", summary: "Piedmont workshop machines — good-value second-hand lathes.", stock: ["haasVf2"] },
  { n: 1108, slug: "sud-presses", name: "Sud Presses & Outillage", email: "contact@sudpresses.example", base: "Lyon, FR", verified: false, plan: "free", summary: "Hydraulic presses and tooling for Rhône-Alpes fabricators.", stock: ["fischer"] },
];

/** type → which rows get which listing type, spread across dealers. */
type RowKind = "for_sale" | "for_rent" | "auction";
const KIND_PLAN: Record<string, RowKind[]> = {
  "alpine-werkzeug": ["for_sale", "for_sale", "auction"],
  "rhein-maschinen": ["for_sale", "auction", "for_rent"],
  "nord-foerdertechnik": ["for_rent", "for_rent"],
  "ibérica-maquinaria": ["for_sale", "for_sale"],
  "lowlands-forklifts": ["for_sale", "for_rent", "auction"],
  "weser-power": ["for_rent", "for_sale"],
  "piemonte-macchine": ["for_sale"],
  "sud-presses": ["auction"],
};

export interface MachinerySeedData {
  userRows: NewUser[];
  opRows: NewOperator[];
  listingRows: NewListing[];
}

export function buildMachinerySeed(): MachinerySeedData {
  const userRows: NewUser[] = DEALERS.map((d, i) => ({
    id: uid(i + 1001),
    email: d.email,
    role: "operator",
  }));
  const opRows: NewOperator[] = DEALERS.map((d) => ({
    id: uid(d.n),
    userId: uid(d.n - 100),
    name: d.name,
    baseAirport: d.base,
    fleetSummary: d.summary,
    verified: d.verified,
    plan: d.plan,
  }));

  const listingRows: NewListing[] = [];
  let n = 1200;
  for (const d of DEALERS) {
    const kinds = KIND_PLAN[d.slug] ?? [];
    d.stock.forEach((key, i) => {
      const m = MACHINES[key];
      if (!m) throw new Error(`unknown machine key: ${key}`);
      const kind = kinds[i] ?? "for_sale";
      const attributes: Record<string, unknown> = {
        machineryCategory: m.category,
        make: `${m.make} ${m.model}`,
        yearOfManufacture: m.year,
        locationCountry: d.base.slice(-2).toUpperCase(),
      };
      if (m.hours !== undefined) attributes.hoursUsed = m.hours;
      if (m.weightKg !== undefined) attributes.weightKg = m.weightKg;
      let priceMinor: number;
      let title: string;
      if (kind === "for_rent") {
        const rent = m.rentEur ?? Math.round((m.askEur ?? 50_000) * 0.035);
        attributes.monthlyRentEur = rent;
        priceMinor = rent * 100;
        title = `${m.make} ${m.model} — for rent`;
      } else {
        priceMinor = Math.round((m.askEur ?? 25_000) * 100);
        title =
          kind === "auction"
            ? `${m.make} ${m.model} — auction lot`
            : `${m.year} ${m.make} ${m.model}`;
      }
      listingRows.push({
        id: uid(n),
        operatorId: uid(d.n),
        vertical: "machinery",
        type: kind,
        title,
        attributes: attributes as NewListing["attributes"],
        priceMinor,
        currency: "EUR",
        status: "active",
        photos: [0, 1].map((p) => photoKey(d.slug, n, p)),
      });
      n += 1;
    });
  }
  return { userRows, opRows, listingRows };
}

function photoKey(dealerSlug: string, listingN: number, photo: number): string {
  return `seed/${dealerSlug}/l${listingN}-p${photo}.svg`;
}

function photoSvg(title: string, variant: number): string {
  const hues = [35, 200, 160, 215, 280, 10];
  const h = hues[variant % hues.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <rect width="800" height="450" fill="hsl(${h},45%,18%)"/>
  <rect x="180" y="230" width="440" height="70" rx="8" stroke="hsl(${h},60%,70%)" stroke-width="6" fill="none"/>
  <circle cx="400" cy="200" r="20" fill="hsl(${h},60%,70%)"/>
  <text x="400" y="360" font-family="system-ui" font-size="26" fill="hsl(${h},30%,85%)" text-anchor="middle">${title}</text>
</svg>`;
}

export interface SeedResult {
  users: number;
  operators: number;
  listings: number;
  photos: number;
}

export const MACHINERY_SEED_COUNTS = { operators: 8, listings: 17 } as const;

export async function seedMachinery(
  db: Db,
  opts: { storageDir?: string } = {},
): Promise<SeedResult> {
  const webStorage = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../apps/web/storage",
  );
  const storageDir =
    opts.storageDir ??
    (process.env.STORAGE_DIR ? resolve(process.env.STORAGE_DIR) : webStorage);
  const { userRows, opRows, listingRows } = buildMachinerySeed();
  const now = new Date();

  let photos = 0;
  for (const l of listingRows) {
    for (const key of l.photos ?? []) {
      const path = join(storageDir, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, photoSvg(l.title, key.length + l.title.length));
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
