import { describe, expect, it } from "vitest";
import { clientIp } from "../../lib/api";

const req = (headers: Record<string, string>) =>
  new Request("http://localhost/api/x", { headers });

describe("clientIp trust order", () => {
  it("prefers platform-set headers over client-spoofable XFF", () => {
    expect(
      clientIp(
        req({ "fly-client-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }),
      ),
    ).toBe("1.2.3.4");
    expect(
      clientIp(
        req({ "x-real-ip": "5.6.7.8", "x-forwarded-for": "9.9.9.9" }),
      ),
    ).toBe("5.6.7.8");
  });

  it("takes the LAST x-forwarded-for hop — leftmost is client-controlled", () => {
    // Chain: <client claim>, <proxy-observed client>, <edge hop>. The entry
    // our immediate upstream appended is the one to trust for bucketing.
    expect(
      clientIp(req({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 10.0.0.1" })),
    ).toBe("10.0.0.1");
    // A single entry (direct connection or lone proxy) is unchanged.
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7" }))).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to 'local' when no headers are present", () => {
    expect(clientIp(req({}))).toBe("local");
  });
});
