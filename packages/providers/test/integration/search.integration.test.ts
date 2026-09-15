import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, databaseUrl, runMigrations, seedJets } from "@jetmarket/db";
import { PostgresSearchProvider } from "../../src/search/postgres";

const { db, sql } = createDb(process.env.DATABASE_URL ?? databaseUrl());

beforeAll(async () => {
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await runMigrations(sql);
  await seedJets(db, { storageDir: "tmp/test-storage-providers" });
});

afterAll(async () => {
  await sql.end();
});

describe("PostgresSearchProvider vs compose postgres + jets seed", () => {
  const search = new PostgresSearchProvider(sql, ["type", "aircraftCategory"]);

  it("returns seeded active listings with a total count", async () => {
    const r = await search.search({ vertical: "jets" });
    expect(r.total).toBe(60);
    expect(r.hits.length).toBeLessThanOrEqual(24);
    expect(r.hits[0]!.priceMinor).toBeGreaterThan(0);
  });

  it("filters by type, text, attribute equality and ranges", async () => {
    const legs = await search.search({ vertical: "jets", type: "empty_leg" });
    expect(legs.total).toBe(27);

    const gva = await search.search({
      vertical: "jets",
      type: "empty_leg",
      filters: { from: "GVA" },
      limit: 100,
    });
    expect(gva.total).toBeGreaterThan(0);
    for (const h of gva.hits) expect(h.attributes["from"]).toBe("GVA");

    const text = await search.search({ vertical: "jets", text: "gulfstream" });
    expect(text.total).toBeGreaterThan(0);

    const seats = await search.search({
      vertical: "jets",
      ranges: { seats: { min: 14 } },
    });
    expect(seats.total).toBeGreaterThan(0);
    for (const h of seats.hits) {
      expect(h.attributes["seats"] as number).toBeGreaterThanOrEqual(14);
    }
  });

  it("computes facet counts over the filtered set", async () => {
    const r = await search.search({
      vertical: "jets",
      filters: { aircraftCategory: "ultra_long" },
    });
    expect(r.facets?.["aircraftCategory"]?.["ultra_long"]).toBe(r.total);
    expect(Object.keys(r.facets?.["type"] ?? {})).toEqual(
      expect.arrayContaining(["charter", "aircraft_sale"]),
    );
  });
});
