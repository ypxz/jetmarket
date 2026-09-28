import { afterEach, describe, expect, it, vi } from "vitest";
import { appOrigin } from "@/lib/origin";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("appOrigin", () => {
  it("prefers APP_URL and trims a trailing slash", () => {
    vi.stubEnv("APP_URL", "https://jets.example/");
    expect(appOrigin(new Request("https://evil.example/api/x"))).toBe(
      "https://jets.example",
    );
  });

  it("falls back to the request origin outside production", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(appOrigin(new Request("http://localhost:3100/api/x"))).toBe(
      "http://localhost:3100",
    );
  });

  it("refuses a host-derived origin in production without APP_URL", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => appOrigin(new Request("https://evil.example/api/x"))).toThrow(
      /APP_URL/,
    );
  });
});
