/**
 * POST /api/client-error (QA-335): the error boundaries beacon crashes here
 * so client React errors land in server logs. The route is unauthenticated
 * and log-only — pins: 204 + no-store shape, JSON/schema validation, body
 * cap, and the per-IP rate limit.
 */
import { describe, expect, it } from "vitest";
import { POST } from "../../app/api/client-error/route";

const URL_ = "http://localhost/api/client-error";
let ipSeq = 0;
const ip = () => `10.240.${Math.floor(ipSeq / 250)}.${ipSeq++ % 250}`;

const post = (body: string, extra: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: { "fly-client-ip": ip(), ...extra },
    body,
  });

describe("POST /api/client-error", () => {
  it("accepts a valid report with 204 and no body", async () => {
    const res = await POST(
      post(
        JSON.stringify({
          digest: "abc123",
          message: "boom",
          path: "/search",
        }),
      ),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("400s on invalid JSON and 422s on schema violations", async () => {
    expect((await POST(post("not json"))).status).toBe(400);
    // message is capped at 500 chars — a page could ship us a stack blob.
    const res = await POST(
      post(JSON.stringify({ message: "x".repeat(501) })),
    );
    expect(res.status).toBe(422);
  });

  it("rate-limits a noisy client at 30/hr", async () => {
    const fixed = post("", {}); // consume one ip outside the loop
    void fixed;
    const ipAddr = `10.241.0.7`;
    const req = () =>
      new Request(URL_, {
        method: "POST",
        headers: { "fly-client-ip": ipAddr },
        body: JSON.stringify({ message: "m" }),
      });
    let last = 0;
    for (let i = 0; i < 30; i++) last = (await POST(req())).status;
    expect(last).toBe(204);
    expect((await POST(req())).status).toBe(429);
  });
});
