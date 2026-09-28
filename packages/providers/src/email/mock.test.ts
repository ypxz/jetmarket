import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it("strips CR/LF from header fields — crafted subjects can't inject", async () => {
    const dir = tmp();
    const email = new MockEmailProvider({ outboxDir: dir });
    const sent = await email.send({
      to: "victim@x.com\r\nBcc: attacker@y.com",
      subject: "Hi\r\nBcc: attacker@y.com",
      replyTo: "me@x.com\nCc: evil@z.com",
      text: "body",
    });
    const eml = readFileSync(join(dir, `${sent.id}.eml`), "utf8");
    // No injected header lines — exactly the expected header names.
    const headers = eml.split("\r\n\r\n")[0]!;
    const names = headers.split("\r\n").map((l) => l.split(":")[0]);
    expect(names).toEqual([
      "From",
      "To",
      "Reply-To",
      "Subject",
      "Date",
      "Content-Type",
    ]);
    expect(headers).toContain("Subject: Hi Bcc: attacker@y.com");
    expect(sent.subject).toBe("Hi Bcc: attacker@y.com");
  });

  it("rejects messages without a body and returns [] for missing dirs", async () => {
    const email = new MockEmailProvider({ outboxDir: tmp() });
    await expect(
      email.send({ to: "a@b.c", subject: "empty" }),
    ).rejects.toThrow(/body/);
    expect(readOutbox("/nonexistent/dir")).toEqual([]);
  });
});
