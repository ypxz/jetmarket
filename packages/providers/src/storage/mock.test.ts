import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockStorageProvider } from "./mock";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jm-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("MockStorageProvider", () => {
  it("puts, gets, urls and deletes objects under STORAGE_DIR", async () => {
    const dir = tmp();
    const s = new MockStorageProvider({ dir });
    const obj = await s.put("seed/a/p.svg", "<svg/>", {
      contentType: "image/svg+xml",
    });
    expect(obj.bytes).toBe(6);
    expect(obj.url).toBe("/storage/seed/a/p.svg");

    expect(Buffer.from((await s.get("seed/a/p.svg"))!).toString()).toBe("<svg/>");
    await s.delete("seed/a/p.svg");
    expect(await s.get("seed/a/p.svg")).toBeNull();
  });

  it("rejects keys escaping the root", async () => {
    const s = new MockStorageProvider({ dir: tmp() });
    await expect(s.put("../escape.txt", "x")).rejects.toThrow(/escapes/);
  });
});
