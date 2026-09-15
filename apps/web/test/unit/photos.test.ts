import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storageProvider } from "@jetmarket/providers";
import { createMemoryRepo } from "@/lib/repo/memory";

// Parallel test files all call createMemoryRepo() → same seed keys. A private
// STORAGE_DIR keeps our put/get assertions off the shared ./storage files —
// otherwise a concurrent truncate+rewrite can be observed as 0 bytes.
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), "jm-photos-"));
(globalThis as { __jmStorage?: unknown }).__jmStorage = undefined;

describe("listing photos via storage provider", () => {
  it("memory seeds store photo keys and the mock provider serves them", async () => {
    const repo = await createMemoryRepo();
    const listings = (await repo.listListings()).filter(
      (l) => l.photos.length > 0,
    );
    expect(listings.length).toBeGreaterThanOrEqual(2);
    for (const l of listings) {
      for (const key of l.photos) {
        expect(storageProvider().url(key)).toBe(`/storage/${key}`);
        const bytes = await storageProvider().get(key);
        expect(bytes).not.toBeNull();
        expect(bytes!.length).toBeGreaterThan(0);
      }
    }
  });
});
