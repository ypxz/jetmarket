import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockEmailProvider, readOutbox } from "./mock";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jm-mail-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("MockEmailProvider", () => {
  it("writes .eml + .json to the outbox dir and readOutbox parses them", async () => {
    const dir = tmp();
    const email = new MockEmailProvider({
      outboxDir: dir,
      from: "JetMarket <noreply@jetmarket.local>",
      now: () => new Date("2026-09-15T12:00:00Z"),
    });
    const sent = await email.send({
      to: "buyer@x.com",
      subject: "Your magic link",
      text: "http://x/verify?token=abc",
    });
    expect(sent.to).toBe("buyer@x.com");

    const box = readOutbox(dir);
    expect(box).toHaveLength(1);
    expect(box[0]!.subject).toBe("Your magic link");
    expect(box[0]!.from).toBe("JetMarket <noreply@jetmarket.local>");
    expect(box[0]!.text).toContain("token=abc");
  });

  it("rejects messages without a body and returns [] for missing dirs", async () => {
    const email = new MockEmailProvider({ outboxDir: tmp() });
    await expect(
      email.send({ to: "a@b.c", subject: "empty" }),
    ).rejects.toThrow(/body/);
    expect(readOutbox("/nonexistent/dir")).toEqual([]);
  });
});
