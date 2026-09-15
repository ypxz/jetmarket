import { describe, expect, it } from "vitest";
import { storageProvider } from "@jetmarket/providers";
import { createMemoryRepo } from "@/lib/repo/memory";

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
